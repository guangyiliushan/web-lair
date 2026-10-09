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
	} catch {
		return null;
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
 * (null = "new file"); it is checked before and after the gate so a save
 * racing another save can never overwrite it silently (grill R2-4; the
 * reload/overwrite choice belongs to the UI).
 */
export async function saveScript(input: {
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

	// Re-check after the (slower) gate: a concurrent save must win over this
	// one, never be overwritten by it.
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
export async function revertToBuiltin(input: {
	dataDir: string;
	name: string;
	actorId: string | null;
	db: ScriptDb;
}): Promise<RevertScriptResult> {
	const { dataDir, name, actorId, db } = input;
	if (!Object.hasOwn(JOBS, name)) return { kind: 'not-forked' };
	const dir = jobsDir(dataDir);
	const target = join(dir, userJobFileName(name));
	if ((await fileInfo(target)) === null) return { kind: 'not-forked' };
	await rm(target, { force: true });
	await rm(sidecarPath(dir, name), { force: true });
	await recordActivity(db, { event: 'job.revert', actorId, payload: { name } });
	return { kind: 'reverted' };
}

export type DeleteScriptResult =
	{ kind: 'deleted'; schedulesRemoved: number; queuedRemoved: number } | { kind: 'not-user-job' };

/**
 * Hard-delete a user-only job (R1-2 lifecycle): once the file is gone the
 * name stops resolving, so its schedule rows and any queued run are cleaned
 * in one transaction with the audit row; run history stays (jobs.prune owns
 * retention). Forked builtins are refused - that action is `revertToBuiltin`.
 */
export async function deleteUserJob(input: {
	dataDir: string;
	name: string;
	actorId: string | null;
	db: ScriptDb;
}): Promise<DeleteScriptResult> {
	const { dataDir, name, actorId, db } = input;
	if (Object.hasOwn(JOBS, name)) return { kind: 'not-user-job' };
	const dir = jobsDir(dataDir);
	const target = join(dir, userJobFileName(name));
	if ((await fileInfo(target)) === null) return { kind: 'not-user-job' };
	await rm(target, { force: true });
	await rm(sidecarPath(dir, name), { force: true });
	return db.transaction(async (tx) => {
		const schedules = await tx
			.delete(jobSchedules)
			.where(eq(jobSchedules.job, name))
			.returning({ id: jobSchedules.id });
		const queued = await tx
			.delete(jobRuns)
			.where(and(eq(jobRuns.job, name), eq(jobRuns.status, 'queued')))
			.returning({ id: jobRuns.id });
		await recordActivity(tx, {
			event: 'job.delete',
			actorId,
			payload: { name, schedules: schedules.length, queued: queued.length }
		});
		return {
			kind: 'deleted' as const,
			schedulesRemoved: schedules.length,
			queuedRemoved: queued.length
		};
	});
}

export type IgnoreUpdateResult =
	{ kind: 'dismissed'; dismissed: string[] } | { kind: 'not-forked' } | { kind: 'no-update' };

/** "Ignore this version": push the current builtin hash into the sidecar. */
export async function ignoreBuiltinUpdate(input: {
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
