/**
 * Default maintenance schedules: a fresh install has no `job_schedules` rows,
 * so the 1-min drain timer ticks with nothing due and maintenance never fires
 * while the timer looks healthy. This seeds the listed defaults idempotently;
 * everything else stays opt-in through the admin surface.
 *
 * One row per job (an operator may change the cron in admin), so re-running
 * is a no-op; rows carry `options.site.timezone` (fallback UTC), matching the
 * admin UI. Usage: `pnpm db:ensure-schedules [--dry-run]`.
 * Details: `deploy/RUNBOOK.md` -> "Background timers (drain)".
 */
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('[ensure-job-schedules] DATABASE_URL is required.');
	process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

const SCHEDULES = [
	{ job: 'jobs.prune', cron: '0 3 * * *' },
	{ job: 'system.resources', cron: '*/15 * * * *' },
	{ job: 'subscriptions.sweep', cron: '30 4 * * *' },
	// AI scanners: cheap no-ops when there is no work (pending translation
	// rows, auto-summary off, or no pending comments).
	{ job: 'ai.translate', cron: '*/10 * * * *' },
	{ job: 'ai.summarize', cron: '0 4 * * *' },
	{ job: 'ai.comment-review', cron: '*/15 * * * *' },
	// Links L4: the public policy promises scheduled checks and a grace-period
	// prune, so both rows must exist on a fresh install (prune runs after check).
	{ job: 'links.check', cron: '0 5 * * *' },
	{ job: 'links.prune', cron: '30 5 * * *' },
	// Content maintenance: revisions keep a per-post cap (cheap, daily);
	// trash/orphans are registered but seeded separately (single-operator rule:
	// `trash.purge` gets no schedule by default).
	{ job: 'revisions.prune', cron: '10 3 * * *' },
	{ job: 'orphans.purge', cron: '40 3 * * 0' },
	// Mail probe: 05:10 daily; the job itself decides whether the
	// site-local Sunday real send is due.
	{ job: 'mail.probe', cron: '10 5 * * *' }
] as const;

async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		// Match the admin UI: new rows default to the site timezone, not UTC.
		const [tzRow] = await sql`
			select value from options where name = 'site.timezone' limit 1
		`;
		const siteTz = typeof tzRow?.value === 'string' && tzRow.value ? tzRow.value : 'UTC';
		for (const schedule of SCHEDULES) {
			if (DRY_RUN) {
				const [row] = await sql`
					select cron_expr, tz, is_enabled from job_schedules
					where job = ${schedule.job}
					limit 1
				`;
				console.log(
					`→ dry-run: ${schedule.job} ${
						row
							? `present (${row.cron_expr}, ${row.tz}, ${row.is_enabled ? 'enabled' : 'disabled'})`
							: 'missing'
					}`
				);
				continue;
			}

			// One row per job, not per (job, cron): an operator may change the cron
			// in admin, and the seed must not add a second schedule next deploy.
			const inserted = await sql`
				insert into job_schedules (job, cron_expr, tz)
				select ${schedule.job}, ${schedule.cron}, ${siteTz}
				where not exists (
					select 1 from job_schedules where job = ${schedule.job}
				)
				on conflict (job, cron_expr) do nothing
				returning id
			`;
			console.log(
				`→ ${inserted.length > 0 ? 'inserted' : 'present (left as configured)'} ${schedule.job}`
			);
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error: unknown) => {
	console.error('[ensure-job-schedules] failed', error);
	process.exit(1);
});
