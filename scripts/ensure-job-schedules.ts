/**
 * Default maintenance schedules (deploy audit L-5, 2026-10-18).
 *
 * `drain` runs every minute, but it only has work when `job_schedules` has a
 * due row. A fresh install had zero rows, so `jobs.prune` and
 * `system.resources` never ran while the timer looked healthy. This script
 * inserts the two safe defaults idempotently; everything else stays opt-in
 * through the admin surface.
 *
 * The pair `(job, cron_expr)` is unique (`job_schedules_job_cron_expr_uniq`),
 * so re-running is a no-op. `tz` keeps its DB default (UTC); the app resolves
 * the site timezone for display/editing.
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
	{ job: 'system.resources', cron: '*/15 * * * *' }
] as const;

async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		for (const schedule of SCHEDULES) {
			if (DRY_RUN) {
				const [row] = await sql`
					select 1 from job_schedules
					where job = ${schedule.job} and cron_expr = ${schedule.cron}
					limit 1
				`;
				console.log(`→ dry-run: ${schedule.job} (${schedule.cron}) ${row ? 'present' : 'missing'}`);
				continue;
			}

			const inserted = await sql`
				insert into job_schedules (job, cron_expr)
				values (${schedule.job}, ${schedule.cron})
				on conflict (job, cron_expr) do nothing
				returning id
			`;
			console.log(
				`→ ${inserted.length > 0 ? 'inserted' : 'present'} ${schedule.job} (${schedule.cron})`
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
