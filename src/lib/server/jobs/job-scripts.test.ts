import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	deleteUserJob,
	getScript,
	ignoreBuiltinUpdate,
	listScripts,
	revertToBuiltin,
	saveScript
} from './job-scripts';
import type { SaveScriptResult } from './job-scripts';
import { ensureJobsScaffold } from './scaffold';

type ScriptDb = Parameters<typeof saveScript>[0]['db'];

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

let tempDirs: string[] = [];

async function tempDataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'wl-jobs-scripts-'));
	tempDirs.push(dir);
	return dir;
}

async function jobFile(dataDir: string, file: string, content: string): Promise<void> {
	const path = join(dataDir, 'jobs', file);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, 'utf8');
}

async function sha256File(path: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(path))
		.digest('hex');
}

function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false
	);
}

/** Fake web db: captures audit inserts and the delete transaction's rows. */
function makeDb(options: { scheduleRows?: unknown[]; queuedRows?: unknown[] } = {}) {
	const auditRows: Record<string, unknown>[] = [];
	const db = {
		insert: vi.fn(() => ({
			values: vi.fn(async (row: Record<string, unknown>) => {
				auditRows.push(row);
			})
		})),
		transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
			let deleteCall = 0;
			const tx = {
				delete: vi.fn(() => ({
					where: vi.fn(() => ({
						returning: vi.fn(async () => {
							deleteCall += 1;
							return deleteCall === 1 ? (options.scheduleRows ?? []) : (options.queuedRows ?? []);
						})
					}))
				})),
				insert: vi.fn(() => ({
					values: vi.fn(async (row: Record<string, unknown>) => {
						auditRows.push(row);
					})
				}))
			};
			return fn(tx);
		})
	};
	return { db: db as unknown as ScriptDb, auditRows, raw: db };
}

afterEach(async () => {
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	tempDirs = [];
});

const VALID_CODE = 'export default { run() {} };\n';

describe('listScripts / getScript', () => {
	it('merges registry and user files with fork state', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		await jobFile(dataDir, 'my-task.ts', VALID_CODE);
		await jobFile(dataDir, 'system-resources.ts', VALID_CODE);

		const infos = await listScripts(dataDir);
		const byName = Object.fromEntries(infos.map((info) => [info.name, info]));
		expect(byName['my-task']).toMatchObject({ source: 'user', forked: false, hasBuiltin: false });
		expect(byName['system.resources']).toMatchObject({
			source: 'user',
			forked: true,
			hasBuiltin: true,
			hasUpdate: false
		});
		expect(byName['jobs.prune']).toMatchObject({ source: 'builtin', forked: false });
		expect(byName['system.resources'].sourceHash).toHaveLength(64);
	});

	it('returns both sides of a fork for the diff view', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		await jobFile(dataDir, 'system-resources.ts', VALID_CODE);
		const bundle = await getScript(dataDir, 'system.resources');
		expect(bundle?.user?.code).toBe(VALID_CODE);
		expect(bundle?.builtin?.code).toContain('system.resources');
		expect(await getScript(dataDir, 'ghost.job')).toBeNull();
	});
});

describe('saveScript', { timeout: 30_000 }, () => {
	it('creates a user-only script with an audit row', async () => {
		const dataDir = await tempDataDir();
		const { db, auditRows } = makeDb();
		const result = await saveScript({
			dataDir,
			name: 'my-task',
			code: VALID_CODE,
			baseHash: null,
			actorId: 'admin-1',
			db
		});
		expect(result).toMatchObject<Partial<SaveScriptResult>>({
			kind: 'saved',
			created: true,
			forked: false
		});
		expect(await readFile(join(dataDir, 'jobs', 'my-task.ts'), 'utf8')).toBe(VALID_CODE);
		expect(await exists(join(dataDir, 'jobs', '.meta', 'my-task.json'))).toBe(false);
		expect(auditRows[0]).toMatchObject({
			event: 'job.save',
			actorId: 'admin-1',
			payload: { name: 'my-task', created: true, forked: false }
		});
	});

	it('rejects gate failures without writing the file', async () => {
		const dataDir = await tempDataDir();
		const { db, auditRows } = makeDb();
		const result = await saveScript({
			dataDir,
			name: 'bad-enum',
			code: 'enum E { A }\n',
			baseHash: null,
			actorId: 'admin-1',
			db
		});
		expect(result.kind).toBe('invalid');
		if (result.kind === 'invalid') {
			expect(result.errors.some((error) => error.code === 1294)).toBe(true);
		}
		expect(await exists(join(dataDir, 'jobs', 'bad-enum.ts'))).toBe(false);
		expect(auditRows).toEqual([]);
	});

	it('rejects bad names before touching anything', async () => {
		const dataDir = await tempDataDir();
		const { db } = makeDb();
		const result = await saveScript({
			dataDir,
			name: 'Bad',
			code: VALID_CODE,
			baseHash: null,
			actorId: null,
			db
		});
		expect(result.kind).toBe('invalid');
		if (result.kind === 'invalid') {
			expect(result.errors[0].source).toBe('name');
		}
	});

	it('enforces the optimistic lock in both directions', async () => {
		const dataDir = await tempDataDir();
		const { db } = makeDb();
		await jobFile(dataDir, 'my-task.ts', VALID_CODE);
		const currentHash = await sha256File(join(dataDir, 'jobs', 'my-task.ts'));

		const stale = await saveScript({
			dataDir,
			name: 'my-task',
			code: VALID_CODE,
			baseHash: 'old',
			actorId: null,
			db
		});
		expect(stale).toEqual({ kind: 'conflict', currentHash });

		const missing = await saveScript({
			dataDir,
			name: 'my-task',
			code: VALID_CODE,
			baseHash: null,
			actorId: null,
			db
		});
		expect(missing.kind).toBe('conflict');

		const updated = 'export default { run() { /* v2 */ } };\n';
		const ok = await saveScript({
			dataDir,
			name: 'my-task',
			code: updated,
			baseHash: currentHash,
			actorId: null,
			db
		});
		expect(ok.kind).toBe('saved');
		expect(await readFile(join(dataDir, 'jobs', 'my-task.ts'), 'utf8')).toBe(updated);
	});

	it('creates the fork sidecar on first save of a builtin-backed name', async () => {
		const dataDir = await tempDataDir();
		const { db, auditRows } = makeDb();
		const result = await saveScript({
			dataDir,
			name: 'system.resources',
			code: VALID_CODE,
			baseHash: null,
			actorId: 'admin-1',
			db
		});
		expect(result).toMatchObject({ kind: 'saved', created: true, forked: true });
		const builtinHash = await sha256File(
			join(repoRoot, 'src', 'lib', 'server', 'jobs', 'builtin', 'system-resources.ts')
		);
		const sidecar = JSON.parse(
			await readFile(join(dataDir, 'jobs', '.meta', 'system-resources.json'), 'utf8')
		);
		expect(sidecar.builtin_hash).toBe(builtinHash);
		expect(sidecar.dismissed_hashes).toEqual([]);
		expect(auditRows[0]).toMatchObject({ event: 'job.fork' });
	});

	it('later saves keep the fork baseline untouched', async () => {
		const dataDir = await tempDataDir();
		const { db, auditRows } = makeDb();
		await jobFile(dataDir, 'system-resources.ts', VALID_CODE);
		await jobFile(
			dataDir,
			'.meta/system-resources.json',
			JSON.stringify({ builtin_hash: 'oldhash', forked_at: '2026-01-01', dismissed_hashes: [] })
		);
		const baseHash = await sha256File(join(dataDir, 'jobs', 'system-resources.ts'));
		const result = await saveScript({
			dataDir,
			name: 'system.resources',
			code: 'export default { run() { /* edited */ } };\n',
			baseHash,
			actorId: null,
			db
		});
		expect(result).toMatchObject({ kind: 'saved', created: false, forked: true });
		const sidecar = JSON.parse(
			await readFile(join(dataDir, 'jobs', '.meta', 'system-resources.json'), 'utf8')
		);
		expect(sidecar.builtin_hash).toBe('oldhash');
		expect(auditRows[0]).toMatchObject({ event: 'job.save' });
	});
});

describe('revertToBuiltin', () => {
	it('removes the fork (file + sidecar) and audits', async () => {
		const dataDir = await tempDataDir();
		const { db, auditRows } = makeDb();
		await jobFile(dataDir, 'system-resources.ts', VALID_CODE);
		const result = await revertToBuiltin({
			dataDir,
			name: 'system.resources',
			actorId: 'admin-1',
			db
		});
		expect(result).toEqual({ kind: 'reverted' });
		expect(await exists(join(dataDir, 'jobs', 'system-resources.ts'))).toBe(false);
		expect(auditRows[0]).toMatchObject({
			event: 'job.revert',
			payload: { name: 'system.resources' }
		});
	});

	it('refuses user-only names', async () => {
		const dataDir = await tempDataDir();
		const { db } = makeDb();
		await jobFile(dataDir, 'my-task.ts', VALID_CODE);
		expect(await revertToBuiltin({ dataDir, name: 'my-task', actorId: null, db })).toEqual({
			kind: 'not-forked'
		});
	});
});

describe('deleteUserJob', () => {
	it('removes the file and cleans schedules + queued runs in one transaction', async () => {
		const dataDir = await tempDataDir();
		const { db, auditRows, raw } = makeDb({
			scheduleRows: [{ id: 's1' }, { id: 's2' }],
			queuedRows: [{ id: 'q1' }]
		});
		await jobFile(dataDir, 'my-task.ts', VALID_CODE);
		const result = await deleteUserJob({ dataDir, name: 'my-task', actorId: 'admin-1', db });
		expect(result).toEqual({ kind: 'deleted', schedulesRemoved: 2, queuedRemoved: 1 });
		expect(await exists(join(dataDir, 'jobs', 'my-task.ts'))).toBe(false);
		expect(raw.transaction).toHaveBeenCalledTimes(1);
		expect(auditRows[0]).toMatchObject({
			event: 'job.delete',
			actorId: 'admin-1',
			payload: { name: 'my-task', schedules: 2, queued: 1 }
		});
	});

	it('refuses forked builtins and keeps their file', async () => {
		const dataDir = await tempDataDir();
		const { db } = makeDb();
		await jobFile(dataDir, 'system-resources.ts', VALID_CODE);
		expect(await deleteUserJob({ dataDir, name: 'system.resources', actorId: null, db })).toEqual({
			kind: 'not-user-job'
		});
		expect(await exists(join(dataDir, 'jobs', 'system-resources.ts'))).toBe(true);
	});
});

describe('ignoreBuiltinUpdate', () => {
	it('dismisses the current builtin hash and clears the update flag', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		await jobFile(dataDir, 'system-resources.ts', VALID_CODE);
		await jobFile(
			dataDir,
			'.meta/system-resources.json',
			JSON.stringify({ builtin_hash: 'oldhash', forked_at: '2026-01-01', dismissed_hashes: [] })
		);
		const before = (await listScripts(dataDir)).find((info) => info.name === 'system.resources');
		expect(before?.hasUpdate).toBe(true);

		const result = await ignoreBuiltinUpdate({ dataDir, name: 'system.resources' });
		expect(result.kind).toBe('dismissed');
		const after = (await listScripts(dataDir)).find((info) => info.name === 'system.resources');
		expect(after?.hasUpdate).toBe(false);
		expect(after?.dismissed).toBe(true);
	});

	it('reports no-update when the baseline already matches', async () => {
		const dataDir = await tempDataDir();
		await jobFile(dataDir, 'system-resources.ts', VALID_CODE);
		const builtinHash = await sha256File(
			join(repoRoot, 'src', 'lib', 'server', 'jobs', 'builtin', 'system-resources.ts')
		);
		await jobFile(
			dataDir,
			'.meta/system-resources.json',
			JSON.stringify({ builtin_hash: builtinHash, forked_at: '2026-01-01', dismissed_hashes: [] })
		);
		expect(await ignoreBuiltinUpdate({ dataDir, name: 'system.resources' })).toEqual({
			kind: 'no-update'
		});
	});
});
