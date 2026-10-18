/**
 * Production migration entry point (D-1, Q3).
 *
 * Why not `drizzle-kit migrate`: drizzle-kit is a devDependency and the
 * runtime image ships production dependencies only. `drizzle-orm`'s migrator
 * reads the same `drizzle/meta/_journal.json` and writes the same
 * `drizzle.__drizzle_migrations` rows — verified 2026-10-17 against a scratch
 * database (id/hash/created_at byte-identical, 48 public tables, re-run
 * idempotent at the time).
 *
 * E2 regenerated the single baseline in place (49 tables). The journal keeps
 * the ORIGINAL `when`, so an existing DB is not re-run; but the CREATE-only
 * baseline cannot upgrade it either. After migrating, the schema preflight
 * below refuses to start the app on a pre-E2 database and points at the
 * rebuild procedure in deploy/RUNBOOK.md §2.1.
 *
 * Usage (host):  node --env-file-if-exists=.env scripts/migrate.ts
 * Usage (container): node scripts/migrate.ts     # env from compose
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('[migrate] DATABASE_URL is not set');
	process.exit(2);
}

const client = postgres(url, { max: 1 });
try {
	await migrate(drizzle(client), { migrationsFolder: './drizzle' });
	console.log('[migrate] migrations applied');
	const [schema] = await client<
		{ suppressions: boolean; consent: boolean; tokenHash: boolean; tokenHashIndex: boolean }[]
	>`select
		to_regclass('public.email_suppressions') is not null as suppressions,
		exists (
			select 1 from information_schema.columns
			where table_schema = 'public' and table_name = 'subscriptions'
				and column_name = 'consent_version'
		) as consent,
		exists (
			select 1 from information_schema.columns
			where table_schema = 'public' and table_name = 'subscriptions'
				and column_name = 'token_hash'
		) as "tokenHash",
		to_regclass('public.subscriptions_token_hash_uniq') is not null as "tokenHashIndex"`;
	if (!schema?.suppressions || !schema.consent || !schema.tokenHash || !schema.tokenHashIndex) {
		console.error(
			'[migrate] this database predates the E2 baseline (missing email_suppressions / consent_version / token_hash / token_hash index).'
		);
		console.error(
			'[migrate] the baseline was regenerated rather than appended; rebuild per deploy/RUNBOOK.md §2.1 (backup -> empty schema -> migrate -> data-only restore -> backfills).'
		);
		process.exitCode = 1;
	}
} catch (error) {
	console.error('[migrate] failed:', error);
	console.error('[migrate] ABORT — do not start the app; restore the pre-migration dump first');
	process.exitCode = 1;
} finally {
	await client.end();
}
