import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { jobRuns } from '../db/system/job-run.schema.ts';
import { jobSchedules } from '../db/system/job-schedule.schema.ts';
import { recordActivity } from '../audit.ts';
import { jobsDir } from './data-dir.ts';
import { builtinModuleFile, JOBS } from './registry.ts';
import { checkJobName, runSaveGate } from './save-gate.ts';
import { ensureJobsScaffold } from './scaffold.ts';
import {
	isCanonicalJobName,
	isNotFoundError,
	listJobs,
	readUserJobMeta,
	resolveJobDefinition,
	sidecarPath,
	userJobFileName
} from './user-layer.ts';
import type { UserJobMeta } from './user-layer.ts';
import type { GateError } from './save-gate.ts';

/**
 * User script store (J-2, plan §5.3/§5.4): the admin-side CRUD around the
 * user layer - read, save (save gate + optimistic-lock conflict + fork
 * sidecar), revert, delete (with the R1-2 schedule/queue cleanup) and
 * builtin-update dismissal. File writes are atomic (tmp + rename); every
 * mutation writes its audit row on the same call path.
 *
 * All user-file mutations run through one in-process queue (J-2 review fix):
 * the web process is the only writer of user job FILES in `$DATA_DIR/jobs`
 * (the drain also refreshes the generated scaffold there, but never user
 * scripts), so the queue makes each check-then-act sequence (save's
 * read-gate-write, delete's tx+rm)
 * atomic per process - the save×save silent-overwrite race and the
 * save×delete / save×revert "resurrection" windows close at the root. The
 * optimistic lock remains the cross-request contract.
 *
 * Web-side module (not part of the drain chain): takes the web app's db
 * handle as an argument, like every other server service.
 */

type ScriptDb = Pick<typeof import('$lib/server/db').db, 'insert' | 'transaction'>;

export interface ScriptSourceInfo {
	code: string;
	hash: string;
	size: number;
	modifiedAt: string | null;
}

export interface ScriptInfo {
	name: string;
	/** Where the code that runs lives (`user` also covers forked builtins). */
	source: 'builtin' | 'user';
	forked: boolean;
	hasBuiltin: boolean;
	description: string;
	manual: boolean;
	scheduleHint: string | null;
	timeoutMs: number;
	/**
	 * Hash of the code that actually runs: the user file when present, else
	 * the builtin source. NOT the value for `saveScript.baseHash` (J-2 review
	 * round 2, dimension 7) - the optimistic-lock token is the hash of the
	 * USER file only (`bundle.user?.hash ?? null`, null when no user file
	 * exists yet).
	 */
	sourceHash: string;
	builtinHash: string | null;
	hasUpdate: boolean;
	dismissed: boolean;
}

export interface ScriptBundle {
	info: ScriptInfo;
	user: ScriptSourceInfo | null;
	builtin: ScriptSourceInfo | null;
}

/**
 * Serialize user-file mutations. `action` runs regardless of the previous
 * operation's outcome; callers receive their own promise.
 */
let jobsFsQueue: Promise<unknown> = Promise.resolve();
function withJobsFsLock<T>(action: () => Promise<T>): Promise<T> {
	const run = jobsFsQueue.then(action, action);
	jobsFsQueue = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

function sha256(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function fileInfo(path: string): Promise<ScriptSourceInfo | null> {
	try {
		const [bytes, stats] = await Promise.all([readFile(path), stat(path)]);
		return {
			code: bytes.toString('utf8'),
			hash: sha256(bytes),
			size: stats.size,
			modifiedAt: stats.mtime.toISOString()
		};
	} catch (error) {
		// Only a genuinely missing file reads as null; a transient read
		// failure must not masquerade as "absent" (J-2 review F7) - that
		// turned permission/blip errors into bogus `created:true` saves and
		// silent fallbacks to builtin code.
		if (isNotFoundError(error)) return null;
		throw error;
	}
}

function builtinSourcePath(name: string): string {
	return fileURLToPath(new URL(`./builtin/${builtinModuleFile(name)}`, import.meta.url));
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
	try {
		await writeFile(tmp, content, 'utf8');
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

async function writeSidecar(dir: string, name: string, meta: UserJobMeta): Promise<void> {
	const path = sidecarPath(dir, name);
	await mkdir(dirname(path), { recursive: true });
	await atomicWrite(path, `${JSON.stringify(meta, null, '\t')}\n`);
}

async function buildInfo(dataDir: string, name: string): Promise<ScriptInfo | null> {
	const hasBuiltin = Object.hasOwn(JOBS, name);
	const definition = await resolveJobDefinition(name, dataDir);
	if (!definition) return null;
	const dir = jobsDir(dataDir);
	const user = await fileInfo(join(dir, userJobFileName(name)));
	const builtin = hasBuiltin ? await fileInfo(builtinSourcePath(name)) : null;
	const sidecar = await readUserJobMeta(dir, name);
	const forked = user !== null && hasBuiltin;
	const builtinHash = builtin?.hash ?? null;
	const dismissed = builtinHash !== null && (sidecar?.dismissed_hashes ?? []).includes(builtinHash);
	const hasUpdate =
		forked &&
		sidecar?.builtin_hash !== undefined &&
		builtinHash !== null &&
		sidecar.builtin_hash !== builtinHash &&
		!dismissed;
	return {
		name,
		source: user ? 'user' : 'builtin',
		forked,
		hasBuiltin,
		description: definition.description,
		manual: definition.manual,
		scheduleHint: definition.scheduleHint,
		timeoutMs: definition.timeoutMs,
		sourceHash: user?.hash ?? builtin?.hash ?? '',
		builtinHash,
		hasUpdate,
		dismissed
	};
}

/** Merged script listing (registry ∪ user files) with fork/update state. */
export async function listScripts(dataDir: string): Promise<ScriptInfo[]> {
	const names = await listJobs(dataDir);
	const infos = await Promise.all(names.map((entry) => buildInfo(dataDir, entry.name)));
	return infos.filter((info): info is ScriptInfo => info !== null);
}

/** One script with both sides' source (editor mount + builtin diff). */
export async function getScript(dataDir: string, name: string): Promise<ScriptBundle | null> {
	const info = await buildInfo(dataDir, name);
	if (!info) return null;
	const dir = jobsDir(dataDir);
	const user = await fileInfo(join(dir, userJobFileName(name)));
	const builtin = info.hasBuiltin ? await fileInfo(builtinSourcePath(name)) : null;
	return { info, user, builtin };
}

export type SaveScriptResult =
	| { kind: 'saved'; hash: string; created: boolean; forked: boolean }
	| { kind: 'conflict'; currentHash: string | null }
	| { kind: 'invalid'; errors: GateError[] };

/**
 * Save a script. `baseHash` is the hash of the exact bytes the editor loaded
 * (null = "new file"); it is checked before and after the gate so a stale
 * editor can never overwrite a newer version silently (grill R2-4; the
 * reload/overwrite choice belongs to the UI). Feed it `bundle.user?.hash ??
 * null` from `getScript` - never `info.sourceHash`, which falls back to the
 * builtin hash for an unforked builtin and would turn every first save into
 * a conflict (J-2 review round 2, dimension 7).
 */
export function saveScript(input: {
	dataDir: string;
	name: string;
	code: string;
	baseHash: string | null;
	actorId: string | null;
	db: ScriptDb;
}): Promise<SaveScriptResult> {
	return withJobsFsLock(() => saveScriptLocked(input));
}

async function saveScriptLocked(input: {
	dataDir: string;
	name: string;
	code: string;
	baseHash: string | null;
	actorId: string | null;
	db: ScriptDb;
}): Promise<SaveScriptResult> {
	const { dataDir, name, code, baseHash, actorId, db } = input;
	const nameErrors = checkJobName(name);
	if (nameErrors.length > 0) return { kind: 'invalid', errors: nameErrors };

	await ensureJobsScaffold(dataDir);
	const dir = jobsDir(dataDir);
	const target = join(dir, userJobFileName(name));
	const before = await fileInfo(target);
	if ((before?.hash ?? null) !== baseHash)
		return { kind: 'conflict', currentHash: before?.hash ?? null };

	const report = await runSaveGate({ name, code });
	if (!report.ok) return { kind: 'invalid', errors: report.errors };

	// Second check after the (slower) gate. The module-level queue already
	// serializes in-process writers, so this arm only matters for a
	// hypothetical second writer process; kept as defense-in-depth (review
	// note: currently no deterministic test input).
	const after = await fileInfo(target);
	if ((after?.hash ?? null) !== baseHash)
		return { kind: 'conflict', currentHash: after?.hash ?? null };

	const hasBuiltin = Object.hasOwn(JOBS, name);
	const created = before === null;
	if (created && hasBuiltin) {
		// First write of a builtin-backed name = the fork (plan §5.3): record
		// the baseline hash upgrade notices compare against. Later writes keep
		// the existing sidecar untouched.
		const existing = await readUserJobMeta(dir, name);
		await writeSidecar(dir, name, {
			builtin_hash: existing?.builtin_hash ?? (await fileInfo(builtinSourcePath(name)))?.hash,
			forked_at: existing?.forked_at ?? new Date().toISOString(),
			dismissed_hashes: existing?.dismissed_hashes ?? []
		});
	}
	await atomicWrite(target, code);
	const hash = sha256(Buffer.from(code, 'utf8'));
	await recordActivity(db, {
		event: created && hasBuiltin ? 'job.fork' : 'job.save',
		actorId,
		payload: { name, created, forked: hasBuiltin, size: Buffer.byteLength(code) }
	});
	return { kind: 'saved', hash, created, forked: hasBuiltin };
}

export type RevertScriptResult = { kind: 'reverted' } | { kind: 'not-forked' };

/** Restore a forked builtin: drop the user file + sidecar; schedules stay. */
export function revertToBuiltin(input: {
	dataDir: string;
	name: string;
	actorId: string | null;
	db: ScriptDb;
}): Promise<RevertScriptResult> {
	return withJobsFsLock(() => revertToBuiltinLocked(input));
}

async function revertToBuiltinLocked(input: {
	dataDir: string;
	name: string;
	actorId: string | null;
	db: ScriptDb;
}): Promise<RevertScriptResult> {
	const { dataDir, name, actorId, db } = input;
	if (!Object.hasOwn(JOBS, name)) return { kind: 'not-forked' };
	const dir = jobsDir(dataDir);
	const target = join(dir, userJobFileName(name));
	if ((await fileInfo(target)) === null) {
		// A crashed earlier revert can leave the file gone with its sidecar
		// orphaned; finish that cleanup so the retry converges instead of
		// stranding the sidecar forever (J-2 review round 2, F-1). Probe by
		// stat, not by parse: a malformed sidecar is still an orphan that
		// must be cleaned (round 3, P3-7). Only a genuinely missing sidecar
		// reads as no-orphan - other stat failures are surfaced in the log
		// (round 4, P4-1, same policy as `fileInfo`).
		const sidecar = sidecarPath(dir, name);
		const orphaned = await stat(sidecar).then(
			() => true,
			(error: unknown) => {
				if (!isNotFoundError(error)) {
					console.error(`[jobs] revertToBuiltin: sidecar probe failed (${name}): ${String(error)}`);
				}
				return false;
			}
		);
		if (!orphaned) return { kind: 'not-forked' };
		// Audit + `reverted` only when the cleanup actually landed (round 4,
		// P4-2): a still-failing rm (directory, persistent EPERM) left the
		// state untouched, so the call did NOT finish the earlier attempt.
		const cleaned = await rm(sidecar, { force: true }).then(
			() => true,
			(error: unknown) => {
				console.error(
					`[jobs] revertToBuiltin: orphan sidecar cleanup failed (${name}): ${String(error)}`
				);
				return false;
			}
		);
		if (!cleaned) return { kind: 'not-forked' };
		await recordActivity(db, { event: 'job.revert', actorId, payload: { name } });
		return { kind: 'reverted' };
	}
	await rm(target, { force: true });
	// The sidecar is metadata: an EPERM here must not fail the revert itself -
	// the next attempt cleans the orphan through the branch above (DB-01/F-1).
	await rm(sidecarPath(dir, name), { force: true }).catch((error: unknown) => {
		console.error(`[jobs] revertToBuiltin: sidecar cleanup failed (${name}): ${String(error)}`);
	});
	await recordActivity(db, { event: 'job.revert', actorId, payload: { name } });
	return { kind: 'reverted' };
}

export type DeleteScriptResult =
	| { kind: 'deleted'; schedulesRemoved: number; queuedRemoved: number; runningFinalized: number }
	| { kind: 'not-user-job' };

/**
 * Hard-delete a user-only job (R1-2 lifecycle): once the file is gone the
 * name stops resolving, so its schedule rows and any queued run are cleaned
 * in one transaction with the audit row; run history stays (jobs.prune owns
 * retention). Forked builtins are refused - that action is `revertToBuiltin`.
 */
export function deleteUserJob(input: {
	dataDir: string;
	name: string;
	actorId: string | null;
	db: ScriptDb;
}): Promise<DeleteScriptResult> {
	return withJobsFsLock(() => deleteUserJobLocked(input));
}

async function deleteUserJobLocked(input: {
	dataDir: string;
	name: string;
	actorId: string | null;
	db: ScriptDb;
}): Promise<DeleteScriptResult> {
	const { dataDir, name, actorId, db } = input;
	// Canonical-name invariant (J-2 review round 2, D1): a registry name is a
	// fork (`revertToBuiltin` owns it), and an alias such as `my.job` maps to
	// `my-job.ts` - deleting through it once removed a DIFFERENT job's file.
	if (Object.hasOwn(JOBS, name) || !isCanonicalJobName(name)) {
		return { kind: 'not-user-job' };
	}
	const dir = jobsDir(dataDir);
	const target = join(dir, userJobFileName(name));
	const sidecar = sidecarPath(dir, name);
	if ((await fileInfo(target)) === null) {
		// A crash between the two rm calls of an earlier attempt leaves a
		// sidecar with no file - clean it so the retry converges instead of
		// reporting not-user-job forever (J-2 review round 2, D7/DB-01;
		// logging added round 3, P3-6/N3).
		await rm(sidecar, { force: true }).catch((error: unknown) => {
			console.error(
				`[jobs] deleteUserJob: orphan sidecar cleanup failed (${name}): ${String(error)}`
			);
		});
		return { kind: 'not-user-job' };
	}
	// DB side first, files after (J-2 review R06): with the file removed
	// first, a failed transaction left a state that could never be retried -
	// the guard above refuses a missing file and the schedules/queued rows
	// were stranded. This order converges on retry: an rm failure after a
	// committed transaction is fixable by running delete again, and the
	// transaction itself is idempotent (0-row deletes on the second pass).
	const counts = await db.transaction(async (tx) => {
		const schedules = await tx
			.delete(jobSchedules)
			.where(eq(jobSchedules.job, name))
			.returning({ id: jobSchedules.id });
		const queued = await tx
			.delete(jobRuns)
			.where(and(eq(jobRuns.job, name), eq(jobRuns.status, 'queued')))
			.returning({ id: jobRuns.id });
		// A crashed run of a deleted name can never be reclaimed through the
		// usual lock path (no definition -> no execution -> no reclaim), so
		// unfinished rows are finalized here (J-2 review R07). A LIVE run is
		// unaffected long-term: it finalizes by id when it ends, overwriting
		// this marker with its real outcome.
		const abandoned = await tx
			.update(jobRuns)
			.set({ status: 'failed', error: 'unknown job (job deleted)' })
			.where(and(eq(jobRuns.job, name), eq(jobRuns.status, 'running')))
			.returning({ id: jobRuns.id });
		await recordActivity(tx, {
			event: 'job.delete',
			actorId,
			payload: {
				name,
				schedules: schedules.length,
				queued: queued.length,
				running: abandoned.length
			}
		});
		return {
			kind: 'deleted' as const,
			schedulesRemoved: schedules.length,
			queuedRemoved: queued.length,
			runningFinalized: abandoned.length
		};
	});
	await rm(target, { force: true });
	// The transaction has committed: a sidecar orphan (Windows EPERM/EBUSY)
	// must not surface as a failed delete - the next attempt or a revert
	// cleans it (J-2 review round 2, DB-01).
	await rm(sidecar, { force: true }).catch((error: unknown) => {
		console.error(`[jobs] deleteUserJob: sidecar cleanup failed (${name}): ${String(error)}`);
	});
	return counts;
}

export type IgnoreUpdateResult =
	{ kind: 'dismissed'; dismissed: string[] } | { kind: 'not-forked' } | { kind: 'no-update' };

/** "Ignore this version": push the current builtin hash into the sidecar. */
export function ignoreBuiltinUpdate(input: {
	dataDir: string;
	name: string;
}): Promise<IgnoreUpdateResult> {
	return withJobsFsLock(() => ignoreBuiltinUpdateLocked(input));
}

async function ignoreBuiltinUpdateLocked(input: {
	dataDir: string;
	name: string;
}): Promise<IgnoreUpdateResult> {
	const { dataDir, name } = input;
	if (!Object.hasOwn(JOBS, name)) return { kind: 'not-forked' };
	const dir = jobsDir(dataDir);
	if ((await fileInfo(join(dir, userJobFileName(name)))) === null) return { kind: 'not-forked' };
	const builtin = await fileInfo(builtinSourcePath(name));
	if (builtin === null) return { kind: 'not-forked' };
	const meta = (await readUserJobMeta(dir, name)) ?? {};
	if (meta.builtin_hash === undefined || meta.builtin_hash === builtin.hash) {
		return { kind: 'no-update' };
	}
	const dismissed = new Set(meta.dismissed_hashes ?? []);
	dismissed.add(builtin.hash);
	await writeSidecar(dir, name, { ...meta, dismissed_hashes: [...dismissed] });
	return { kind: 'dismissed', dismissed: [...dismissed] };
}
