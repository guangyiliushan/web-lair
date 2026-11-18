import { sql, type SQL } from 'drizzle-orm';

/**
 * PostgreSQL zoneinfo membership — the write gate on timezone registration:
 * names PostgreSQL rejects must not be stored.
 * ICU and PostgreSQL's zoneinfo set disagree in BOTH directions: 'Japan',
 * 'US/Pacific' and 'Asia/Calcutta' pass Intl's `isValidIanaTimeZone` while
 * `AT TIME ZONE` rejects them, and 'Asia/Kolkata' goes the other way.
 * `notes.tz` and `site.timezone` are consumed in SQL (`(published_at at
 * time zone coalesce(tz, $site))::date`), so a PG-rejected name makes every
 * belongs-to query 500 while the row is present. Write paths run BOTH
 * gates: the sync Intl probe (zod schema / editor) plus this check.
 * Callers may inject an executor to join an open transaction; the default
 * resolves the app db lazily (keeps the module importable from plain
 * scripts, mirroring options-registry).
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
