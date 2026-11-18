import {
	driverLabel,
	providerFingerprint,
	type StorageActive,
	type StorageMigrationState,
	type StorageProviderConfig
} from './provider.ts';
import { assessDeletion, type BucketCapabilities } from './port.ts';

/**
 * Provider activation + rollback.
 * Activation is NOT reachable from a form: `storage.provider` is the
 * candidate and this module the only writer of `storage.active` (cutover CLI).
 * Three guards stand in front of a switch:
 * 1. a NEW addressing target needs a complete copy of that fingerprint when
 *    media exists (`files > 0`); a delete-mode-only change needs no copy -
 *    the objects are already in the bucket.
 * 2. the target bucket must answer HEAD and its versioning/object-lock
 *    verdict must be PROVABLE (unknown is not "off" - fail closed).
 * 3. a versioned / object-locked bucket only activates in logical-delete
 *    mode, an explicit operator choice.
 */

export type ActivationErrorCode =
	| 'migration-required'
	| 'migration-incomplete'
	| 'no-previous'
	| 'same-provider'
	| 'capability-unknown'
	| 'versioning-blocked'
	| 'target-unavailable'
	| 'post-cutover-objects';

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
	/** Both option rows in ONE transaction (a partial cutover must not exist). */
	applyActivation(active: StorageActive, migration: StorageMigrationState): Promise<void>;
	countFiles(): Promise<number>;
	/** Files created after `since` (null = all files); used by the rollback guard. */
	countFilesSince(since: string | null): Promise<number>;
	/** The CANDIDATE bucket: HEAD + capabilities, with the candidate credentials. */
	headBucket(): Promise<void>;
	capabilities(): Promise<BucketCapabilities>;
	audit(event: string, payload: Record<string, unknown>): Promise<void>;
	now?(): Date;
}

export interface ActivationResult {
	from: StorageProviderConfig;
	to: StorageProviderConfig;
	files: number;
	activatedAt: string;
}

/**
 * Identity of an activation, as opposed to a copy target: the addressing half
 * plus the delete mode. A site must be able to move from hard to logical delete
 * on the SAME bucket (that is the documented opt-in for a versioned bucket),
 * so "already active" has to look at both.
 */
export function activationIdentity(config: StorageProviderConfig): string {
	return `${providerFingerprint(config)}|${config.deleteMode}`;
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

	const sameAddressing = providerFingerprint(active.config) === providerFingerprint(candidate);
	if (sameAddressing && activationIdentity(active.config) === activationIdentity(candidate)) {
		throw new ActivationError('same-provider', 'The saved provider is already the active one');
	}
	if (!sameAddressing && files > 0) {
		assertMigrationComplete(migration, candidate, files);
	}

	// The target must exist and be readable with these credentials. A typo'd
	// bucket would otherwise activate on the empty-registry path and 503 every
	// /i request afterwards.
	try {
		await store.headBucket();
	} catch {
		throw new ActivationError(
			'target-unavailable',
			'The target bucket is not reachable with the configured credentials (HEAD failed)'
		);
	}

	const capabilities = await store.capabilities();
	const assessment = assessDeletion(capabilities);
	if (!assessment.provable) {
		throw new ActivationError(
			'capability-unknown',
			'Bucket versioning/object lock could not be read; refusing to activate (fail closed)'
		);
	}
	if (!assessment.reclaims && candidate.deleteMode !== 'logical') {
		throw new ActivationError(
			'versioning-blocked',
			'The target bucket has versioning or object lock enabled; choose logical delete or use a plain bucket'
		);
	}

	const activatedAt = (store.now?.() ?? new Date()).toISOString();
	await store.applyActivation(
		{ config: candidate, previous: active.config, activatedAt },
		{
			...migration,
			state: 'cutover',
			cutoverAt: activatedAt,
			finishedAt: migration.finishedAt ?? activatedAt
		}
	);
	await store.audit('storage.activate', {
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

	// Objects written after the cutover exist only on the CURRENT provider.
	// Rolling back without copying them makes them unreachable, so refuse and
	// name the count (the operator can copy them back first).
	const createdSinceCutover = await store.countFilesSince(active.activatedAt);
	if (createdSinceCutover > 0) {
		throw new ActivationError(
			'post-cutover-objects',
			`${createdSinceCutover} file(s) were uploaded after the cutover and exist only on the current provider; copy them back before rolling back`
		);
	}

	const activatedAt = (store.now?.() ?? new Date()).toISOString();
	const target = active.previous;
	await store.applyActivation(
		{
			config: target,
			// Swap, so a mistaken rollback can be re-run the other way.
			previous: active.config,
			activatedAt
		},
		{ ...migration, state: 'rolled-back' }
	);
	await store.audit('storage.activate', {
		action: 'rollback',
		from: driverLabel(active.config),
		to: driverLabel(target),
		files: await store.countFiles()
	});
	return { from: active.config, to: target, files: await store.countFiles(), activatedAt };
}
