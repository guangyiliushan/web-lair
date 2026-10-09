import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureJobsScaffold } from './scaffold';
import {
	DEFAULT_USER_JOB_TIMEOUT_MS,
	jobNameForUserFile,
	listJobs,
	listUserJobFiles,
	readUserJobMeta,
	resolveJobDefinition,
	USER_JOB_TIMEOUT_MAX_MS,
	userJobFileExists
} from './user-layer';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

let tempDirs: string[] = [];

async function tempDataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'wl-jobs-user-'));
	tempDirs.push(dir);
	return dir;
}

async function jobFile(dataDir: string, file: string, content: string): Promise<void> {
	const path = join(dataDir, 'jobs', file);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, 'utf8');
}

afterEach(async () => {
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	tempDirs = [];
});

describe('jobNameForUserFile', () => {
	it('maps builtin module file names back to registry names (forks)', () => {
		expect(jobNameForUserFile('jobs-prune.ts')).toBe('jobs.prune');
		expect(jobNameForUserFile('links-check.ts')).toBe('links.check');
		expect(jobNameForUserFile('projects-sync.ts')).toBe('projects.sync');
	});

	it('accepts user-only names and rejects everything else', () => {
		expect(jobNameForUserFile('my-task.ts')).toBe('my-task');
		expect(jobNameForUserFile('_sdk.runtime.ts')).toBeNull();
		expect(jobNameForUserFile('package.json')).toBeNull();
		expect(jobNameForUserFile('Bad.ts')).toBeNull();
		expect(jobNameForUserFile('bad name.ts')).toBeNull();
		expect(jobNameForUserFile('con.ts')).toBeNull();
		expect(jobNameForUserFile('../evil.ts')).toBeNull();
	});
});

describe('listUserJobFiles / listJobs', () => {
	it('lists only valid job files and merges with the registry', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		await writeFile(join(dataDir, 'jobs', 'my-task.ts'), 'export default { run() {} };\n', 'utf8');
		await mkdir(join(dataDir, 'jobs', 'weird.ts'), { recursive: true }); // directory, ignored
		await writeFile(join(dataDir, 'jobs', 'Bad.ts'), '', 'utf8');

		const files = await listUserJobFiles(dataDir);
		expect(files.map((entry) => entry.name)).toEqual(['my-task']);

		const merged = await listJobs(dataDir);
		const byName = Object.fromEntries(merged.map((entry) => [entry.name, entry.source]));
		expect(byName['my-task']).toBe('user');
		expect(byName['system.resources']).toBe('builtin');
	});
});

describe('resolveJobDefinition', () => {
	it('returns registry metadata for builtins, null for unknown names', async () => {
		const dataDir = await tempDataDir();
		const builtin = await resolveJobDefinition('jobs.prune', dataDir);
		expect(builtin?.name).toBe('jobs.prune');
		expect(builtin?.timeoutMs).toBe(300_000);
		expect(await resolveJobDefinition('ghost.job', dataDir)).toBeNull();
	});

	it('gives user-only jobs the R1-2 defaults', async () => {
		const dataDir = await tempDataDir();
		await jobFile(dataDir, 'my-task.ts', 'export default { run() {} };\n');
		const definition = await resolveJobDefinition('my-task', dataDir);
		expect(definition).toMatchObject({
			name: 'my-task',
			manual: true,
			scheduleHint: null,
			timeoutMs: DEFAULT_USER_JOB_TIMEOUT_MS
		});
	});

	it('applies a valid sidecar timeout_ms to user-only and registry jobs', async () => {
		const dataDir = await tempDataDir();
		await jobFile(dataDir, 'my-task.ts', 'export default { run() {} };\n');
		await jobFile(dataDir, '.meta/my-task.json', JSON.stringify({ timeout_ms: 45_000 }));
		expect((await resolveJobDefinition('my-task', dataDir))?.timeoutMs).toBe(45_000);

		await jobFile(dataDir, '.meta/system-resources.json', JSON.stringify({ timeout_ms: 60_000 }));
		expect((await resolveJobDefinition('system.resources', dataDir))?.timeoutMs).toBe(60_000);
	});

	it('ignores out-of-range, malformed and non-integer sidecar timeouts', async () => {
		const dataDir = await tempDataDir();
		await jobFile(dataDir, 'my-task.ts', 'export default { run() {} };\n');

		await jobFile(dataDir, '.meta/my-task.json', JSON.stringify({ timeout_ms: 10 }));
		expect((await resolveJobDefinition('my-task', dataDir))?.timeoutMs).toBe(
			DEFAULT_USER_JOB_TIMEOUT_MS
		);

		await jobFile(dataDir, '.meta/my-task.json', JSON.stringify({ timeout_ms: 1e12 }));
		expect((await resolveJobDefinition('my-task', dataDir))?.timeoutMs).toBe(
			DEFAULT_USER_JOB_TIMEOUT_MS
		);

		await jobFile(dataDir, '.meta/my-task.json', JSON.stringify({ timeout_ms: 1.5 }));
		expect((await resolveJobDefinition('my-task', dataDir))?.timeoutMs).toBe(
			DEFAULT_USER_JOB_TIMEOUT_MS
		);

		await jobFile(dataDir, '.meta/my-task.json', 'not json at all');
		expect((await resolveJobDefinition('my-task', dataDir))?.timeoutMs).toBe(
			DEFAULT_USER_JOB_TIMEOUT_MS
		);
		expect(await readUserJobMeta(join(dataDir, 'jobs'), 'my-task')).toBeNull();

		await jobFile(
			dataDir,
			'.meta/my-task.json',
			JSON.stringify({ timeout_ms: USER_JOB_TIMEOUT_MAX_MS })
		);
		expect((await resolveJobDefinition('my-task', dataDir))?.timeoutMs).toBe(
			USER_JOB_TIMEOUT_MAX_MS
		);
	});
});

describe('userJobFileExists', () => {
	it('is path-safe and reflects the filesystem', async () => {
		const dataDir = await tempDataDir();
		expect(await userJobFileExists(dataDir, 'my-task')).toBe(false);
		await jobFile(dataDir, 'my-task.ts', 'export default { run() {} };\n');
		expect(await userJobFileExists(dataDir, 'my-task')).toBe(true);
		expect(await userJobFileExists(dataDir, '../evil')).toBe(false);
	});
});

describe('createJobLoader (plain Node child)', () => {
	it('loads user-only jobs, SDK-importing jobs and user forks of builtins', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		await jobFile(dataDir, 'my-task.ts', 'export default { run() {} };\n');
		await jobFile(
			dataDir,
			'sdk-task.ts',
			"import { getDb } from '#jobs-sdk';\nexport default { run() { return typeof getDb; } };\n"
		);
		await jobFile(
			dataDir,
			'system-resources.ts',
			"export default { run() { return 'user-fork'; } };\n"
		);

		const script = `
			const { createJobLoader, resolveJobDefinition } = await import('./src/lib/server/jobs/user-layer.ts');
			const dataDir = ${JSON.stringify(dataDir)};
			const loader = createJobLoader({ dataDir });
			const job = await loader('my-task');
			if (typeof job.run !== 'function' || !/^[a-f0-9]{64}$/.test(job.sourceHash)) throw new Error('user-only job did not load');
			const sdk = await loader('sdk-task');
			if (typeof sdk.run !== 'function') throw new Error('SDK-importing job did not load');
			const forked = await loader('system.resources');
			if ((await forked.run({})) !== 'user-fork') throw new Error('user layer must win over the builtin');
			const def = await resolveJobDefinition('my-task', dataDir);
			if (!def || def.timeoutMs !== ${DEFAULT_USER_JOB_TIMEOUT_MS} || def.manual !== true) throw new Error('user-only definition wrong');
			const forkedDef = await resolveJobDefinition('system.resources', dataDir);
			if (!forkedDef || forkedDef.name !== 'system.resources') throw new Error('forked definition wrong');
			console.log('user-layer child ok');
		`;
		const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
			cwd: repoRoot,
			timeout: 30_000
		});
		expect(stdout).toContain('user-layer child ok');
	}, 20_000);
});
