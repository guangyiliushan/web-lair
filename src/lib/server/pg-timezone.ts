import { sql, type SQL } from 'drizzle-orm';

/**
 * PostgreSQL zoneinfo membership - the batch-5 closure of the timezone
 * registration (ledger §13.9 / notes plan §3.3).
 *
 * `isValidIanaTimeZone` probes ICU (Intl), and ICU and the PostgreSQL
 * zoneinfo set disagree in BOTH directions (real-PG probes): 'Japan' /
 * 'US/Pacific' / 'Asia/Calcutta' pass Intl but `AT TIME ZONE` rejects them;
 * 'Asia/Kolkata' goes the other way. Values stored in `notes.tz` or the
 * `site.timezone` option are consumed in SQL
 * (`(published_at at time zone coalesce(tz, $site))::date`), so a
 * PG-rejected name makes every belongs-to query 500 with that row present.
 * Write paths therefore run BOTH gates: the Intl probe (sync, in the zod
 * schema / editor) plus this membership check.
 *
 * Callers may inject an executor so the check can join an open transaction;
 * the default resolves the app db lazily (keeps the module importable from
 * plain scripts, mirroring options-registry).
 */
export interface PgTimeZoneExecutor {
	execute: (query: SQL) => Promise<unknown> | unknown;
}

export async function isPgAcceptableTimeZone(
	tz: string,
	executor?: PgTimeZoneExecutor
): Promise<boolean> {
	const database = executor ?? ((await import('$lib/server/db')).db as PgTimeZoneExecutor);
	const rows = (await database.execute(
		sql`select 1 from pg_timezone_names where name = ${tz} limit 1`
	)) as Array<unknown>;
	return rows.length > 0;
}
