import {
	copyObjects,
	type CopyOutcome,
	type MigrationObject,
	type MigrationPlan
} from './migrate.ts';
import type { ObjectStoragePort } from './port.ts';
import { DEFAULT_STORAGE_MIGRATION, type StorageMigrationState } from './provider.ts';

/**
 * Copy phase orchestration, extracted from the CLI so it can be tested with fake ports (the CLI runs
 * `main()` at import time, which vitest cannot import).
 * Heartbeat invariant: the running counters live OUTSIDE the copyObjects call, because `onBefore` fires
 * before the promise resolves - reading them from the call's own result is a temporal-dead-zone error on
 * the first object and froze uploads with `state='copying'` and nothing copied.
 * Variants the source never had are not failures (only some files have variants), so a missing VARIANT
 * counts as `missingVariants`; a missing CANONICAL object stays fatal. The persisted `total` counts only
 * objects that must exist, so `verified === total` is reachable for a healthy install.
 */

export interface CopyPhaseDeps {
	objects: MigrationObject[];
	source: ObjectStoragePort;
	target: ObjectStoragePort;
	runId: string;
	sourceFingerprint: string;
	targetFingerprint: string;
	/** Persist the state row (the CLI writes the options table). */
	saveState: (state: StorageMigrationState) => Promise<void>;
	/** Plan numbers for the opening state (informational). */
	plan: Pick<MigrationPlan, 'total' | 'bytes'>;
	now?: () => Date;
	/** How often the running state is persisted (default 25 objects). */
	heartbeatEvery?: number;
	/** Per-object progress reporter (CLI logs a line every N). */
	onProgress?: (progress: { index: number; total: number; key: string; outcome: string }) => void;
}

export interface CopyPhaseResult {
	state: StorageMigrationState;
	outcome: CopyOutcome;
	/** Objects that must exist on the target (copied + skipped + failed). */
	present: number;
}

export async function runCopyPhase(deps: CopyPhaseDeps): Promise<CopyPhaseResult> {
	const now = deps.now ?? (() => new Date());
	const heartbeatEvery = deps.heartbeatEvery ?? 25;
	const counters = { copied: 0, skipped: 0, verified: 0, missingVariants: 0, failed: 0 };

	let state: StorageMigrationState = {
		...DEFAULT_STORAGE_MIGRATION,
		state: 'copying',
		id: deps.runId,
		startedAt: now().toISOString(),
		sourceFingerprint: deps.sourceFingerprint,
		targetFingerprint: deps.targetFingerprint,
		total: deps.plan.total,
		bytes: deps.plan.bytes
	};
	await deps.saveState(state);

	const outcome = await copyObjects(
		deps.objects,
		{ source: deps.source, target: deps.target },
		{
			onProgress: (progress) => {
				switch (progress.outcome) {
					case 'copied':
						counters.copied += 1;
						counters.verified += 1;
						break;
					case 'verified':
						counters.skipped += 1;
						counters.verified += 1;
						break;
					case 'no-variant':
						counters.missingVariants += 1;
						break;
					default:
						counters.failed += 1;
				}
				deps.onProgress?.(progress);
			},
			onBefore: async (progress) => {
				if (progress.index % heartbeatEvery !== 1) return;
				state = {
					...state,
					copied: counters.copied + counters.skipped,
					verified: counters.verified,
					failed: counters.failed
				};
				await deps.saveState(state);
			}
		}
	);

	const failed = outcome.failed.length;
	// The engine's counters are authoritative for the final row (they see the
	// same events the outcome aggregates).
	const present = outcome.copied + outcome.skipped + failed;
	state = {
		...state,
		state: failed === 0 ? 'copied' : 'failed',
		finishedAt: now().toISOString(),
		total: present,
		copied: outcome.copied + outcome.skipped,
		verified: outcome.verified,
		failed,
		bytes: outcome.bytes,
		error: failed === 0 ? null : `${failed} object(s) failed`
	};
	await deps.saveState(state);

	return { state, outcome, present };
}
