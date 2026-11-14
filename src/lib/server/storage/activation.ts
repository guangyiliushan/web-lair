import {
	driverLabel,
	providerFingerprint,
	type StorageActive,
	type StorageMigrationState,
	type StorageProviderConfig
} from './provider.ts';

/**
 * Provider activation + rollback (W7.4, decision Q13/Q4).
 *
 * Activation is deliberately NOT reachable from a form: `storage.provider` is
 * the candidate, and this module is the only writer of `storage.active` (the
 * cutover CLI calls it). Two guards stand in front of a switch:
 *
 *   1. media on disk → the copy must be complete for THIS target fingerprint
 *      (`files` count vs verified count, zero failures). An empty `files` table
 *      may activate directly (there is nothing to copy).
 *   2. bucket capabilities (W7.5): a versioned / object-locked bucket cannot be
 *      hard-deleted into, so an activation that would pretend to reclaim space
 *      is refused unless logical delete was chosen explicitly.
 *
 * The previous live config is kept as the rollback slot; rollback swaps it
 * back and records `rolled-back` — the old provider stays readable throughout.
 */

export type ActivationErrorCode =
	| 'migration-required'
	| 'migration-incomplete'
	| 'no-previous'
	| 'same-provider'
	| 'capability-unknown'
	| 'versioning-blocked';

export class ActivationError extends Error {
	readonly code: ActivationErrorCode;

	constructor(code: ActivationErrorCode, message: string) {
		super(message);
		this.name = 'ActivationError';
		this.code = code;
	}
}

export interface ActivationStore {
	getActive(): Promise<StorageActive>;
	getProvider(): Promise<StorageProviderConfig>;
	getMigration(): Promise<StorageMigrationState>;
	setActive(active: StorageActive): Promise<void>;
	setMigration(migration: StorageMigrationState): Promise<void>;
	countFiles(): Promise<number>;
	/**
	 * Live capability read of the CANDIDATE bucket (W7.5). Returning null means
	 * the probe could not answer, which fails closed.
	 */
	capabilities?(): Promise<{ versioning: string; objectLock: boolean | null } | null>;
	audit?(event: string, payload: Record<string, unknown>): Promise<void>;
	now?(): Date;
}

export interface ActivationResult {
	from: StorageProviderConfig;
	to: StorageProviderConfig;
	files: number;
	activatedAt: string;
}

/** Only an exact, complete copy of THIS target may be cut over. */
function assertMigrationComplete(
	migration: StorageMigrationState,
	target: StorageProviderConfig,
	files: number
): void {
	const fingerprint = providerFingerprint(target);
	if (migration.state !== 'copied') {
		throw new ActivationError(
			'migration-required',
			'Run `pnpm storage:migrate --yes` before cutting over: the saved provider has no completed copy'
		);
	}
	if (migration.targetFingerprint !== fingerprint) {
		throw new ActivationError(
			'migration-incomplete',
			'The completed copy belongs to a different provider configuration; re-run the copy'
		);
	}
	if (migration.failed > 0 || migration.verified < migration.total) {
		throw new ActivationError(
			'migration-incomplete',
			`The copy is incomplete (${migration.verified}/${migration.total} objects verified, ${migration.failed} failed)`
		);
	}
	if (files > 0 && migration.total === 0) {
		throw new ActivationError(
			'migration-incomplete',
			'The registry has media but the recorded copy planned zero objects'
		);
	}
}

export async function activateSavedProvider(store: ActivationStore): Promise<ActivationResult> {
	const [active, candidate, migration, files] = await Promise.all([
		store.getActive(),
		store.getProvider(),
		store.getMigration(),
		store.countFiles()
	]);

	if (providerFingerprint(active.config) === providerFingerprint(candidate)) {
		throw new ActivationError('same-provider', 'The saved provider is already the active one');
	}

	if (files > 0) {
		assertMigrationComplete(migration, candidate, files);
	}

	// W7.5 capability guard: refusing here is what keeps "purge frees space"
	// true. A bucket with versioning/object lock on only ever gets logical
	// deletion, which must be chosen explicitly in the provider form.
	const capabilities = store.capabilities ? await store.capabilities() : null;
	if (!capabilities) {
		throw new ActivationError(
			'capability-unknown',
			'Bucket versioning/object lock could not be read; refusing to activate (fail closed)'
		);
	}
	const deletable = capabilities.versioning === 'off' && capabilities.objectLock !== true;
	if (!deletable && candidate.deleteMode !== 'logical') {
		throw new ActivationError(
			'versioning-blocked',
			'The target bucket has versioning or object lock enabled; choose logical delete or use a plain bucket'
		);
	}

	const activatedAt = (store.now?.() ?? new Date()).toISOString();
	const next: StorageActive = {
		config: candidate,
		previous: active.config,
		activatedAt,
		activatedBy: null
	};
	await store.setActive(next);
	await store.setMigration({
		...migration,
		state: 'cutover',
		cutoverAt: activatedAt,
		finishedAt: migration.finishedAt ?? activatedAt
	});
	await store.audit?.('storage.activate', {
		action: 'activate',
		from: driverLabel(active.config),
		to: driverLabel(candidate),
		files,
		versioning: capabilities.versioning,
		object_lock: capabilities.objectLock,
		delete_mode: candidate.deleteMode
	});

	return { from: active.config, to: candidate, files, activatedAt };
}

/** Switch back to the config the last cutover replaced. */
export async function rollbackToPreviousProvider(
	store: ActivationStore
): Promise<ActivationResult> {
	const [active, migration] = await Promise.all([store.getActive(), store.getMigration()]);
	if (!active.previous) {
		throw new ActivationError('no-previous', 'There is no previous provider to roll back to');
	}
	const activatedAt = (store.now?.() ?? new Date()).toISOString();
	const target = active.previous;
	await store.setActive({
		config: target,
		// Swap, so a mistaken rollback can be re-run the other way.
		previous: active.config,
		activatedAt,
		activatedBy: null
	});
	await store.setMigration({ ...migration, state: 'rolled-back' });
	await store.audit?.('storage.activate', {
		action: 'rollback',
		from: driverLabel(active.config),
		to: driverLabel(target),
		files: await store.countFiles()
	});
	return { from: active.config, to: target, files: await store.countFiles(), activatedAt };
}
