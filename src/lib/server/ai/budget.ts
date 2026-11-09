import { and, eq, gte, sql } from 'drizzle-orm';
import { aiUsage } from '../db/ai/ai-usage.schema.ts';
import { activities } from '../db/system/activity.schema.ts';
import { getOption } from '../config/options-registry.ts';
import { AiError } from './errors.ts';
import type { AiDb } from './types.ts';

export interface AiBudgetState {
	monthly: number;
	currency: string;
	alertRatios: number[];
	pauseAutoOnExceed: boolean;
	spent: number;
	unpricedCalls: number;
	/**
	 * Successful calls with no price-table entry. When a budget is enforced
	 * these make spending unmeasurable, so automatic calls pause (fail
	 * closed) instead of running without a working budget.
	 */
	unpricedSuccessCalls: number;
	/** True when a non-zero budget is exhausted and automatic calls must pause. */
	paused: boolean;
}

function monthStart(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** Month-to-date cost. Unpriced calls are counted separately, never guessed. */
export async function readBudgetState(db: AiDb, now = new Date()): Promise<AiBudgetState> {
	const budget = await getOption('ai.budget', db);
	const [row] = await db
		.select({
			spent: sql<string | null>`sum(${aiUsage.costEstimate})`,
			unpriced: sql<number>`count(*) filter (where ${aiUsage.costEstimate} is null)`.mapWith(
				Number
			),
			unpricedSuccess:
				sql<number>`count(*) filter (where ${aiUsage.costEstimate} is null and ${aiUsage.status} = 'success')`.mapWith(
					Number
				)
		})
		.from(aiUsage)
		.where(gte(aiUsage.createdAt, monthStart(now)));
	const spent = row?.spent == null ? 0 : Number(row.spent);
	const unpricedCalls = row?.unpriced ?? 0;
	const unpricedSuccessCalls = row?.unpricedSuccess ?? 0;
	const monthly = budget.monthly;
	return {
		monthly,
		currency: budget.currency,
		alertRatios: budget.alertRatios,
		pauseAutoOnExceed: budget.pauseAutoOnExceed,
		spent,
		unpricedCalls,
		unpricedSuccessCalls,
		// Fail closed: an enforced budget with unmeasurable spend pauses
		// automatic work rather than silently running without a budget.
		paused:
			monthly > 0 && budget.pauseAutoOnExceed && (spent >= monthly || unpricedSuccessCalls > 0)
	};
}

/**
 * Pre-call gate. Manual admin actions remain available when the budget is
 * exhausted (`pauseAutoOnExceed` only pauses automatic work); a job call is
 * refused before any provider request is made.
 */
export async function assertBudget(
	db: AiDb,
	manual: boolean,
	now = new Date()
): Promise<AiBudgetState> {
	const state = await readBudgetState(db, now);
	if (state.paused && !manual) {
		const reason =
			state.unpricedSuccessCalls > 0 && state.spent < state.monthly
				? `${state.unpricedSuccessCalls} call(s) have no price-table entry, so the ${state.monthly} ${state.currency} budget cannot be enforced`
				: `AI monthly budget exceeded (${state.spent.toFixed(2)} / ${state.monthly} ${state.currency})`;
		throw new AiError('budget', reason);
	}
	return state;
}

/**
 * Record one activity row per crossed alert ratio per month. `activities`
 * has no unique constraint, so the query-before-insert is best-effort; a
 * duplicate alert is harmless, a missing one is not.
 */
export async function recordBudgetAlerts(
	db: AiDb,
	state: AiBudgetState,
	now = new Date()
): Promise<void> {
	if (state.monthly <= 0) return;
	const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
	for (const ratio of state.alertRatios) {
		if (state.spent < state.monthly * ratio) continue;
		const [existing] = await db
			.select({ id: activities.id })
			.from(activities)
			.where(
				and(
					eq(activities.event, 'ai.budget_alert'),
					sql`${activities.payload}->>'month' = ${month}`,
					sql`(${activities.payload}->>'ratio')::numeric = ${ratio}`
				)
			)
			.limit(1);
		if (existing) continue;
		try {
			await db.insert(activities).values({
				event: 'ai.budget_alert',
				payload: {
					month,
					ratio,
					spent: Math.round(state.spent * 100) / 100,
					monthly: state.monthly,
					currency: state.currency
				}
			});
		} catch (caught) {
			console.warn(
				'[ai] failed to record budget alert',
				caught instanceof Error ? caught.message : caught
			);
		}
	}
}
