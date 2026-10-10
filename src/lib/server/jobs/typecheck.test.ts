import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureJobsScaffold } from './scaffold';
import { parseTscDiagnostics, runJobsTypecheck } from './typecheck';

let tempDirs: string[] = [];

async function tempDataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'wl-jobs-typecheck-'));
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

describe('parseTscDiagnostics', () => {
	it('parses plain tsc output lines and caps the list', () => {
		const output = [
			"bad.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			'Found 1 error in bad.ts:3'
		].join('\n');
		expect(parseTscDiagnostics(output)).toEqual([
			{
				file: 'bad.ts',
				line: 3,
				column: 5,
				message: "TS2322: Type 'string' is not assignable to type 'number'."
			}
		]);
		const many = Array.from({ length: 5 }, (_, index) => `f${index}.ts(1,1): error TS1: x`).join(
			'\n'
		);
		expect(parseTscDiagnostics(many, 2)).toHaveLength(2);
	});

	it('ignores non-diagnostic noise', () => {
		expect(parseTscDiagnostics('something else entirely\n')).toEqual([]);
	});
});

describe('runJobsTypecheck', () => {
	it('is a no-op pass with no user scripts', async () => {
		const dataDir = await tempDataDir();
		const summary = await runJobsTypecheck({ dataDir });
		expect(summary).toMatchObject({ ok: true, fileCount: 0, errorCount: 0, issues: [] });
	});

	it('passes a well-typed script that imports the SDK facade', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		await jobFile(
			dataDir,
			'good.ts',
			"import { type JobContext } from '#jobs-sdk';\nexport default { run(ctx: JobContext): void { ctx.logger.info('ok'); } };\n"
		);
		const summary = await runJobsTypecheck({ dataDir });
		expect(summary).toMatchObject({ ok: true, fileCount: 1, errorCount: 0 });
		if (!summary.ok) console.log('typecheck issues:', JSON.stringify(summary.issues));
	}, 60_000);

	it('reports type errors with positions', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		await jobFile(
			dataDir,
			'bad.ts',
			"const x: number = 'nope';\nexport default { run() { return x; } };\n"
		);
		const summary = await runJobsTypecheck({ dataDir });
		expect(summary.ok).toBe(false);
		expect(summary.errorCount).toBeGreaterThanOrEqual(1);
		const issue = summary.issues.find((entry) => entry.message.includes('TS2322'));
		expect(issue?.file).toBe('bad.ts');
		expect(issue?.line).toBe(1);
	}, 60_000);
});

describe('jobs.typecheck builtin wrapper (J-2 review: run-package coverage)', () => {
	it('maps the service summary into the job result', async () => {
		const dataDir = await tempDataDir();
		await jobFile(
			dataDir,
			'good.ts',
			"import { type JobContext } from '#jobs-sdk';\nexport default { run(ctx: JobContext): void { ctx.logger.info('ok'); } };\n"
		);
		const previous = process.env.DATA_DIR;
		process.env.DATA_DIR = dataDir;
		try {
			const builtin = (await import('./builtin/jobs-typecheck')).default;
			const summaries: Record<string, unknown>[] = [];
			await builtin.run({
				job: 'jobs.typecheck',
				trigger: 'cli',
				db: {} as never,
				logger: { info: () => {}, warn: () => {}, error: () => {} },
				summary: (data: Record<string, unknown>) =>
					Object.assign(summaries[0] ?? (summaries[0] = {}), data)
			} as never);
			// One good file: `files` and `errors` must map distinctly (the
			// all-zero fixture let a files<->errors swap survive round 2, P1-2).
			expect(summaries[0]).toMatchObject({
				ok: true,
				files: 1,
				errors: 0,
				timedOut: false,
				runnerError: null
			});
		} finally {
			if (previous === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = previous;
		}
	}, 60_000);
});
