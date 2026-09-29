import { CronExpressionParser } from 'cron-parser';

/** Hard bound on the backwards scan per tick; `missed` caps at this number. */
const MAX_CATCHUP_SCAN = 500;

export class CronExprError extends Error {}

/**
 * Cron gate (plan §4.9): exactly five fields, no seconds field. cron-parser
 * itself accepts 6-field expressions, so the field count is enforced here
 * before parsing. The save gate (J-2) will run this too; drain runs it per
 * row so a hand-inserted row fails loudly instead of firing every second.
 */
export function assertCronExpr(expr: string): void {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new CronExprError(
			`cron expression must have exactly 5 fields (no seconds field), got ${fields.length}: "${expr}"`
		);
	}
}

export interface DueSnapshot {
	/** The most recent due point in the window - the one this tick catches up to. */
	latestDue: Date;
	/** Due points in `(lastDueAt, now]`; the run carries `missed = dues - 1`. */
	dues: number;
}

/**
 * Catch-up snapshot (plan §4.1, scenario 85): when at least one due point
 * falls in `(lastDueAt, now]`, the caller executes exactly ONE run - for the
 * most recent due - and advances the watermark straight to `latestDue`
 * (earlier missed points are skipped, never executed one by one).
 *
 * Firing uses the cron wall clock in the schedule's own `tz`; Luxon under
 * cron-parser handles DST. Returns null when nothing is due.
 */
export function dueWindow(
	cronExpr: string,
	tz: string,
	lastDueAt: Date,
	now: Date
): DueSnapshot | null {
	assertCronExpr(cronExpr);
	if (lastDueAt.getTime() >= now.getTime()) return null;
	// The window is right-closed - `now` itself counts as due - while
	// cron-parser's prev() is exclusive of currentDate, hence the +1ms nudge.
	const iterator = CronExpressionParser.parse(cronExpr, {
		tz,
		currentDate: new Date(now.getTime() + 1)
	});
	let latestDue: Date | null = null;
	let dues = 0;
	for (let index = 0; index < MAX_CATCHUP_SCAN; index++) {
		// Iterator errors are NOT swallowed: a broken row must be loud (per-row
		// isolation logs it every tick) instead of a schedule that silently
		// never fires again.
		const previous = iterator.prev().toDate();
		if (previous.getTime() <= lastDueAt.getTime()) break;
		if (latestDue === null) latestDue = previous;
		dues += 1;
	}
	if (latestDue === null) return null;
	return { latestDue, dues };
}
