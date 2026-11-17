/**
 * Production migration entry point.
 *
 * Why not `drizzle-kit migrate`: drizzle-kit is a devDependency and the
 * runtime image ships production dependencies only. `drizzle-orm`'s migrator
 * reads the same `drizzle/meta/_journal.json` and writes the same
 * `drizzle.__drizzle_migrations` rows (verified byte-identical on a scratch
 * database; re-runs idempotent).
 *
 * The single CREATE-only baseline has been regenerated in place several times
 * (E2, provenance, S1, taxonomy, default category, translation runtime), and
 * the journal keeps the original `when`, so an existing database silently
 * skips it. The schema preflights below exit 1 on a database predating a
 * regenerated baseline and point at the matching rebuild section in
 * `deploy/RUNBOOK.md` ("E2 baseline rebuild", "Provenance baseline rebuild",
 * "Update"). None of these guards run in the app process: deploy scripts
 * must run `migrate` before `up -d`.
 *
 * Usage (host): `node --env-file-if-exists=.env scripts/migrate.ts`
 * Usage (container): `node scripts/migrate.ts`   # env from compose
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
		{
			suppressions: boolean;
			consent: boolean;
			tokenHash: boolean;
			tokenHashIndex: boolean;
			provenance: boolean;
			tokenNonce: boolean;
			keyVersion: boolean;
			taxonomy: boolean;
			defaultCategory: boolean;
			translationRuntime: boolean;
			m4Foundation: boolean;
		}[]
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
		to_regclass('public.subscriptions_token_hash_uniq') is not null as "tokenHashIndex",
		(
			select count(*) = 5 from information_schema.columns
			where table_schema = 'public' and table_name = 'posts'
				and column_name in (
					'writing_origin', 'ai_help',
					'provenance_source', 'provenance_updated_at', 'provenance_updated_by'
				)
		) as provenance,
		exists (
			select 1 from information_schema.columns
			where table_schema = 'public' and table_name = 'subscriptions'
				and column_name = 'token_nonce'
		) as "tokenNonce",
		exists (
			select 1 from information_schema.columns
			where table_schema = 'public' and table_name = 'email_suppressions'
				and column_name = 'key_version'
		) as "keyVersion",
		(
			select count(*) = 5 from information_schema.columns
			where table_schema = 'public' and (
				(table_name = 'categories' and column_name in ('source_lang', 'name_i18n'))
				or (table_name = 'topics' and column_name in ('source_lang', 'name_i18n', 'description_i18n'))
			)
		) as taxonomy,
		exists (
			select 1 from information_schema.columns
			where table_schema = 'public' and table_name = 'categories'
				and column_name = 'is_default'
		) as "defaultCategory",
		(
			select count(*) = 9 from information_schema.columns
			where table_schema = 'public' and table_name = 'translations'
				and column_name in (
					'runs', 'attempt', 'started_at', 'heartbeat_at', 'stage',
					'waiting_reason', 'cancel_requested', 'progress', 'overwrite_target'
				)
		) as "translationRuntime",
		(
			select count(*) = 3 from information_schema.columns
			where table_schema = 'public' and (
				(table_name = 'user_profiles' and column_name = 'header_label')
				or (table_name = 'site_identity' and column_name = 'owner_user_id')
				or (table_name = 'home_hero' and column_name = 'subtitle_highlight')
			)
		) as "m4Foundation"`;
	if (!schema?.suppressions || !schema.consent || !schema.tokenHash || !schema.tokenHashIndex) {
		console.error(
			'[migrate] this database predates the E2 baseline (missing email_suppressions / consent_version / token_hash / token_hash index).'
		);
		console.error(
			'[migrate] the baseline was regenerated rather than appended; rebuild per deploy/RUNBOOK.md §2.1 (backup -> empty schema -> migrate -> data-only restore -> backfills).'
		);
		process.exitCode = 1;
	}
	if (!schema?.provenance) {
		console.error(
			'[migrate] this database predates the provenance baseline (posts is missing one of writing_origin / ai_help / provenance_source / provenance_updated_at / provenance_updated_by).'
		);
		console.error(
			'[migrate] the journal timestamp is unchanged, so the migrator skips the regenerated baseline; rebuild per deploy/RUNBOOK.md §2.2 (backup -> empty schema -> migrate -> data restore -> provenance backfill).'
		);
		process.exitCode = 1;
	}
	if (!schema?.tokenNonce || !schema?.keyVersion) {
		console.error(
			'[migrate] this database predates the S1 baseline (missing subscriptions.token_nonce / email_suppressions.key_version).'
		);
		console.error(
			'[migrate] the baseline was regenerated rather than appended; rebuild per deploy/RUNBOOK.md §2 (backup -> empty schema -> migrate -> data-only restore -> verify).'
		);
		process.exitCode = 1;
	}
	if (schema?.taxonomy === false) {
		console.error(
			'[migrate] this database predates the taxonomy i18n baseline (missing categories.source_lang / topics.description_i18n).'
		);
		console.error(
			'[migrate] the baseline was regenerated rather than appended; rebuild per deploy/RUNBOOK.md §2 (backup -> empty schema -> migrate -> data-only restore -> verify).'
		);
		process.exitCode = 1;
	}
	if (schema?.defaultCategory === false) {
		console.error(
			'[migrate] this database predates the default-category baseline (missing categories.is_default).'
		);
		console.error(
			'[migrate] the baseline was regenerated rather than appended; rebuild per deploy/RUNBOOK.md §2 (backup -> empty schema -> migrate -> data-only restore -> db:ensure-categories -> verify).'
		);
		process.exitCode = 1;
	}
	if (schema?.translationRuntime === false) {
		console.error(
			'[migrate] this database predates the translation runtime baseline (translations is missing one of runs / attempt / started_at / heartbeat_at / stage / waiting_reason / cancel_requested / progress / overwrite_target).'
		);
		console.error(
			'[migrate] the journal timestamp is unchanged, so the migrator skips the regenerated baseline; rebuild per deploy/RUNBOOK.md §2 (backup -> empty schema -> migrate -> data-only restore -> verify).'
		);
		process.exitCode = 1;
	}
	if (schema?.m4Foundation === false) {
		console.error(
			'[migrate] this database is missing the M4 foundation objects (user_profiles.header_label / site_identity / home_hero).'
		);
		console.error(
			'[migrate] append 0003 did not land; do not start the app. Re-run migrate and check the SQL.'
		);
		process.exitCode = 1;
	}
} catch (error) {
	console.error('[migrate] failed:', error);
	console.error('[migrate] ABORT — do not start the app.');
	console.error(
		'[migrate] a failure here may mean the database predates the E2 or provenance baseline; rebuild per deploy/RUNBOOK.md §2.1/§2.2 (a dump restore cannot add the missing ledger row).'
	);
	process.exitCode = 1;
} finally {
	await client.end();
}
