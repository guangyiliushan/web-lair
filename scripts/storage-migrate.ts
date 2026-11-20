import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/lib/server/db/schema';
import { getOption, setOption } from '../src/lib/server/config/options-registry';
import { recordActivity } from '../src/lib/server/audit';
import { storageConfigForProvider } from '../src/lib/server/storage/config';
import { resolveStorageCredentials } from '../src/lib/server/secrets/storage-credentials';
import { S3Storage } from '../src/lib/server/storage/s3';
import {
	enumerateMigrationObjects,
	planMigration,
	type MigrationSourceRow
} from '../src/lib/server/storage/migrate';
import { runCopyPhase } from '../src/lib/server/storage/migrate-run';
import {
	activateSavedProvider,
	rollbackToPreviousProvider,
	ActivationError,
	type ActivationStore
} from '../src/lib/server/storage/activation';
import {
	DEFAULT_STORAGE_MIGRATION,
	driverLabel,
	providerFingerprint,
	type StorageProviderConfig
} from '../src/lib/server/storage/provider';

/**
 * Provider migration CLI: source is `storage.active`, target is the saved
 * candidate (`storage.provider`).
 *   pnpm ops storage migrate --dry-run   enumerate + HEAD both buckets (default)
 *   pnpm ops storage migrate --yes       freeze uploads, copy + verify, persist state
 *   pnpm ops storage migrate --cutover   activate the saved candidate (guarded)
 *   pnpm ops storage migrate --rollback  switch back to the previous provider
 *   pnpm ops storage migrate --status    print active/candidate/migration state
 *   pnpm ops storage migrate --reset     clear a stuck state (no live run)
 *
 * Objects are never deleted from the source. Sequence, gates and upload
 * freeze: uploads stop and purge refuses while the copy runs. Out of scope:
 * `maps/*.pmtiles` are not
 * `files` rows; re-run `pnpm ops maps publish` after cutover.
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL is required (use --env-file=.env).');
	process.exit(1);
}

type Mode = 'dry-run' | 'copy' | 'cutover' | 'rollback' | 'status' | 'reset';

const args = new Set(process.argv.slice(2));
const mode: Mode = args.has('--yes')
	? 'copy'
	: args.has('--cutover')
		? 'cutover'
		: args.has('--rollback')
			? 'rollback'
			: args.has('--status')
				? 'status'
				: args.has('--reset')
					? 'reset'
					: 'dry-run';
const execute = mode !== 'dry-run' && mode !== 'status';

const sql = postgres(DATABASE_URL, { max: 1 });
const db = drizzle(sql, { schema });

/**
 * Credentials come from the encrypted store first, the environment second
 * The local driver needs none, so it never touches the secret table.
 */
async function buildStorage(provider: StorageProviderConfig): Promise<S3Storage> {
	const credentials =
		provider.driver === 'local'
			? null
			: await resolveStorageCredentials(db as never, { getEnv: (name) => process.env[name] });
	return new S3Storage(storageConfigForProvider(provider, { source: process.env, credentials }));
}

async function countFiles(): Promise<number> {
	const [row] = await sql<{ n: number }[]>`select count(*)::int as n from files`;
	return row?.n ?? 0;
}

async function migrationRows(): Promise<MigrationSourceRow[]> {
	const rows = await sql<
		{ object_key: string; content_hash: string; byte_size: number }[]
	>`select object_key, content_hash, byte_size::int as byte_size from files order by object_key`;
	return rows.map((row) => ({
		objectKey: row.object_key,
		contentHash: row.content_hash,
		byteSize: row.byte_size
	}));
}

function activationStore(target: S3Storage): ActivationStore {
	return {
		getActive: () => getOption('storage.active', db),
		getProvider: () => getOption('storage.provider', db),
		getMigration: () => getOption('storage.migration', db),
		// One transaction: a cutover must never leave the live provider and the
		// migration row disagreeing (partial switch recovery).
		applyActivation: (active, migration) =>
			db.transaction(async (tx) => {
				await setOption('storage.active', active, tx);
				await setOption('storage.migration', migration, tx);
			}),
		countFiles,
		countFilesSince: async (since) => {
			const rows = since
				? await sql<
						{ n: number }[]
					>`select count(*)::int as n from files where created_at > ${since}::timestamptz`
				: await sql<{ n: number }[]>`select count(*)::int as n from files`;
			return rows[0]?.n ?? 0;
		},
		headBucket: () => target.headBucket(),
		capabilities: () => target.bucketCapabilities(),
		audit: (event, payload) => recordActivity(db, { event, actorId: null, payload, deliver: false })
	};
}

function describe(provider: StorageProviderConfig): string {
	const where =
		provider.driver === 'local' ? 'env RUSTFS_*' : `${provider.endpoint} / ${provider.bucket}`;
	return `${driverLabel(provider)} (${where}, ${provider.forcePathStyle ? 'path' : 'vhost'}, region ${provider.region})`;
}

async function main(): Promise<void> {
	// A mutating run takes a session-level advisory lock: a second agent or
	// operator gets a clear refusal instead of a second copier.
	if (execute) {
		const [lock] = await sql<{ locked: boolean }[]>`
			select pg_try_advisory_lock(hashtext('web-lair:storage:migrate')) as locked
		`;
		if (!lock?.locked) {
			console.error('Another storage migrate run holds the lock. Wait for it or inspect it first.');
			process.exitCode = 1;
			return;
		}
	}

	const [active, candidate, migration] = await Promise.all([
		getOption('storage.active', db),
		getOption('storage.provider', db),
		getOption('storage.migration', db)
	]);
	const files = await countFiles();
	const sourceFingerprint = providerFingerprint(active.config);
	const targetFingerprint = providerFingerprint(candidate);

	if (mode === 'status') {
		console.log(`active     ${describe(active.config)}`);
		console.log(`           ${sourceFingerprint}`);
		console.log(`candidate  ${describe(candidate)}`);
		console.log(`           ${targetFingerprint}`);
		console.log(
			`files      ${files}${files > 0 ? ' (a copy is required before cutover)' : ' (direct activation allowed)'}`
		);
		console.log(`migration  ${migration.state}  ${migration.id ?? '—'}`);
		if (migration.startedAt) {
			console.log(
				`           started ${migration.startedAt}  verified ${migration.verified}/${migration.total}  failed ${migration.failed}`
			);
		}
		if (migration.error) console.log(`           error: ${migration.error}`);
		return;
	}

	if (mode === 'reset') {
		await setOption('storage.migration', { ...DEFAULT_STORAGE_MIGRATION }, db);
		console.log('migration state reset to idle (no copy is running: the lock was free).');
		return;
	}

	if (mode === 'rollback') {
		const target = await buildStorage(active.config);
		try {
			const result = await rollbackToPreviousProvider(activationStore(target));
			console.log(`rolled back: ${describe(result.from)} → ${describe(result.to)}`);
		} catch (error) {
			if (error instanceof ActivationError) {
				console.error(`rollback refused (${error.code}): ${error.message}`);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
		return;
	}

	// Every remaining mode talks to both buckets.
	const source = await buildStorage(active.config);
	const target = await buildStorage(candidate);

	if (mode === 'cutover') {
		try {
			const result = await activateSavedProvider(activationStore(target));
			console.log(`cut over: ${describe(result.from)} → ${describe(result.to)}`);
			console.log('The previous provider stays readable; run --rollback to switch back.');
		} catch (error) {
			if (error instanceof ActivationError) {
				console.error(`cutover refused (${error.code}): ${error.message}`);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
		return;
	}

	const objects = enumerateMigrationObjects(await migrationRows());
	const plan = await planMigration(objects, { source, target });
	console.log(`mode        ${mode === 'copy' ? 'COPY' : 'dry-run'}`);
	console.log(`source      ${describe(active.config)}`);
	console.log(`target      ${describe(candidate)}`);
	console.log(`files       ${files} registry rows`);
	console.log(
		`objects     ${plan.total} (${plan.canonical} canonical + ${plan.variants} variants), ${plan.bytes} bytes on record`
	);
	console.log(`on target   ${plan.existingOnTarget}`);
	console.log(`to copy     ${plan.pending}`);
	if (plan.missingVariants > 0) {
		console.log(
			`variants    ${plan.missingVariants} absent on the source (normal for files without variants)`
		);
	}
	if (plan.missingOnSource.length > 0) {
		console.error(
			`FATAL: ${plan.missingOnSource.length} canonical object(s) are registered but missing from the source bucket:`
		);
		for (const key of plan.missingOnSource.slice(0, 20)) console.error(`  - ${key}`);
		console.error(
			'Refusing to copy: the registry and the bucket disagree. Run pnpm ops media audit first.'
		);
		process.exitCode = 1;
		return;
	}
	if (mode === 'dry-run') {
		console.log('\nNo changes (dry-run). Re-run with --yes to copy, then --cutover.');
		return;
	}

	const runId = crypto.randomUUID();
	await recordActivity(db, {
		event: 'storage.migrate',
		actorId: null,
		payload: {
			action: 'start',
			run: runId,
			source: sourceFingerprint,
			target: targetFingerprint,
			total: plan.total,
			bytes: plan.bytes
		},
		deliver: false
	});

	// The copy phase (state writes + heartbeat + final row) lives in the
	// storage layer so it can be tested without importing this CLI.
	const { state, outcome, present } = await runCopyPhase({
		objects,
		source,
		target,
		runId,
		sourceFingerprint,
		targetFingerprint,
		plan,
		saveState: (next) => setOption('storage.migration', next, db),
		onProgress: (progress) => {
			if (progress.outcome !== 'verified' && progress.outcome !== 'copied') {
				console.error(`  ${progress.index}/${progress.total} ${progress.key}: ${progress.outcome}`);
			} else if (progress.index % 25 === 0 || progress.index === progress.total) {
				console.log(`  ${progress.index}/${progress.total} objects (${progress.outcome})`);
			}
		}
	});

	const failed = outcome.failed.length;
	await recordActivity(db, {
		event: 'storage.migrate',
		actorId: null,
		payload: {
			action: 'finish',
			run: runId,
			target: targetFingerprint,
			total: present,
			copied: outcome.copied,
			skipped: outcome.skipped,
			missing_variants: outcome.missingVariants,
			verified: outcome.verified,
			failed
		},
		deliver: false
	});

	console.log(
		`
copied ${outcome.copied}, already present ${outcome.skipped}, verified ${outcome.verified}/${present}, no variant ${outcome.missingVariants}, failed ${failed}`
	);
	if (state.state === 'failed') {
		console.error('The copy is INCOMPLETE. Fix the failures and re-run --yes (it resumes).');
		process.exitCode = 1;
		return;
	}
	console.log(
		'Copy complete. Run `pnpm ops storage migrate --cutover` inside the maintenance window.'
	);
}

await main().finally(async () => {
	await sql.end();
});
