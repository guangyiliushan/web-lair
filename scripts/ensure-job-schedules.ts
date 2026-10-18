/**
 * Default maintenance schedules (deploy audit L-5, 2026-10-18).
 *
 * `drain` runs every minute, but it only has work when `job_schedules` has a
 * due row. A fresh install had zero rows, so `jobs.prune` and
 * `system.resources` never ran while the timer looked healthy. This script
 * inserts the three safe defaults idempotently; everything else stays opt-in
 * through the admin surface.
 *
 * `subscriptions.sweep` (email hardening E1-2) deletes pending rows after 30
 * days. The pair `(job, cron_expr)` is unique
 * (`job_schedules_job_cron_expr_uniq`), so re-running is a no-op. `tz` keeps
 * its DB default (UTC); the app resolves the site timezone for display/editing.
 * Actually: the script reads options.site.timezone and inserts it (fallback UTC),
 * matching the admin UI.
 *
 * Usage: node scripts/ensure-job-schedules.ts [--dry-run]
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
	{ job: 'subscriptions.sweep', cron: '30 4 * * *' }
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
