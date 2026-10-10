import { stripTypeScriptTypes } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from './data-dir';
import { ensureJobsScaffold, runtimeContent, sdkRuntimeSpecifier } from './scaffold';

const SDK_PATH = join(repoRoot, 'src', 'lib', 'server', 'jobs', 'jobs-sdk.ts');

let tempDirs: string[] = [];

async function tempDataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'wl-jobs-scaffold-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	tempDirs = [];
});

describe('sdkRuntimeSpecifier', () => {
	it('builds a relative posix specifier on the same drive', () => {
		const spec = sdkRuntimeSpecifier(
			'D:/repo/data/jobs',
			'D:/repo/src/lib/server/jobs/jobs-sdk.ts'
		);
		expect(spec).toBe('../../src/lib/server/jobs/jobs-sdk.ts');
	});

	it.skipIf(process.platform !== 'win32')(
		'falls back to a file URL when path.relative cannot express the path',
		() => {
			// Pick the OTHER drive dynamically: a hard-coded C: made this test
			// red on any checkout living on C: (review round 2, P2-5).
			const other = /^c:/i.test(repoRoot) ? 'D:' : 'C:';
			const spec = sdkRuntimeSpecifier(`${other}/elsewhere/jobs`, SDK_PATH);
			expect(spec.startsWith('file:///')).toBe(true);
			expect(fileURLToPath(spec).endsWith('jobs-sdk.ts')).toBe(true);
			// Repo-independent fixed pairs (round 3, M14a): both branches pinned
			// to concrete drives so discrimination does not depend on where the
			// repository happens to live.
			const crossDrive = sdkRuntimeSpecifier('D:/x/jobs', 'C:/y/src/lib/server/jobs/jobs-sdk.ts');
			expect(crossDrive.startsWith('file:///')).toBe(true);
			const sameDrive = sdkRuntimeSpecifier('C:/x/jobs', 'C:/x/src/lib/server/jobs/jobs-sdk.ts');
			expect(sameDrive).toBe('../src/lib/server/jobs/jobs-sdk.ts');
		}
	);

	it('escapes the re-export specifier so quoted paths stay parseable (review D5)', () => {
		const target = "D:/my 'repo/src/lib/server/jobs/jobs-sdk.ts";
		const spec = sdkRuntimeSpecifier('D:/wl-data/jobs', target);
		expect(spec.startsWith('file:///')).toBe(true);
		expect(spec).toContain("'"); // pathToFileURL does not encode the quote
		const generated = runtimeContent(spec);
		expect(generated).toContain(`export * from ${JSON.stringify(spec)};`);
		expect(generated).not.toContain(`'${spec}'`);
		expect(() => stripTypeScriptTypes(generated, { mode: 'strip' })).not.toThrow();
	});
});

describe('ensureJobsScaffold', () => {
	it('creates the jobs dir and all four artifacts on first run', async () => {
		const dataDir = await tempDataDir();
		const result = await ensureJobsScaffold(dataDir);
		expect(result.dir).toBe(join(dataDir, 'jobs'));
		expect(result.changed.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual([
			'_sdk.d.ts',
			'_sdk.runtime.ts',
			'package.json',
			'tsconfig.json'
		]);
	});

	it('is idempotent: a second run reports no changes', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		const again = await ensureJobsScaffold(dataDir);
		expect(again.changed).toEqual([]);
	});

	it('self-heals a tampered artifact and reports only that file', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		const tsconfig = join(dataDir, 'jobs', 'tsconfig.json');
		await writeFile(tsconfig, '{ "tampered": true }\n', 'utf8');
		const healed = await ensureJobsScaffold(dataDir);
		expect(healed.changed).toEqual([tsconfig]);
		expect(JSON.parse(await readFile(tsconfig, 'utf8')).compilerOptions.erasableSyntaxOnly).toBe(
			true
		);
	});

	it('writes the package.json import map the plan pins', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		const pkg = JSON.parse(await readFile(join(dataDir, 'jobs', 'package.json'), 'utf8'));
		expect(pkg).toEqual({
			type: 'module',
			imports: {
				'#jobs-sdk': { types: './_sdk.d.ts', default: './_sdk.runtime.ts' }
			}
		});
	});

	it('the runtime re-export resolves back to the repository SDK module', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		const dir = join(dataDir, 'jobs');
		const runtime = await readFile(join(dir, '_sdk.runtime.ts'), 'utf8');
		const spec = /export \* from "([^"]+)";/.exec(runtime)?.[1];
		expect(spec).toBeTruthy();
		const resolved = spec!.startsWith('file:') ? fileURLToPath(spec!) : resolve(dir, spec!);
		expect(resolved).toBe(SDK_PATH);
	});

	it('copies the facade verbatim from the repository', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		const copied = await readFile(join(dataDir, 'jobs', '_sdk.d.ts'), 'utf8');
		const source = await readFile(
			join(repoRoot, 'src', 'lib', 'server', 'jobs', 'sdk-facade.d.ts'),
			'utf8'
		);
		expect(copied).toBe(source);
	});

	it('generated tsconfig carries the official Node block and repo anchors', async () => {
		const dataDir = await tempDataDir();
		await ensureJobsScaffold(dataDir);
		const config = JSON.parse(await readFile(join(dataDir, 'jobs', 'tsconfig.json'), 'utf8'));
		expect(config.compilerOptions).toMatchObject({
			noEmit: true,
			target: 'esnext',
			module: 'nodenext',
			moduleResolution: 'nodenext',
			rewriteRelativeImportExtensions: true,
			erasableSyntaxOnly: true,
			verbatimModuleSyntax: true
		});
		expect(config.compilerOptions.types).toEqual(['node']);
		expect(config.compilerOptions.typeRoots[0].replaceAll('\\', '/')).toBe(
			join(repoRoot, 'node_modules', '@types').replaceAll('\\', '/')
		);
		expect(config.exclude).toContain('_sdk.runtime.ts');
		// Pinned after the J-2 review: the strictness keys are part of what
		// makes jobs.typecheck meaningful - a silently dropped `strict` must
		// fail here, not sail through.
		expect(config.compilerOptions.strict).toBe(true);
		expect(config.compilerOptions.skipLibCheck).toBe(true);
		expect(config.compilerOptions.lib).toEqual(['esnext']);
		expect(config.include).toEqual(['./**/*.ts']);
	});

	it('uses the file URL form when the differing path part carries unusual characters', () => {
		// Same-drive paths with spaces in a SHARED ancestor still get a plain
		// relative specifier (the relative part is clean); the URL form is for
		// unusual characters in the part a relative specifier must carry.
		const clean = sdkRuntimeSpecifier('D:/a b/jobs', 'D:/a b/src/lib/server/jobs/jobs-sdk.ts');
		expect(clean.startsWith('../')).toBe(true);
		const spec = sdkRuntimeSpecifier(
			'D:/wl-data/jobs',
			'D:/my repo/src/lib/server/jobs/jobs-sdk.ts'
		);
		expect(spec.startsWith('file:///')).toBe(true);
		expect(fileURLToPath(spec).endsWith('jobs-sdk.ts')).toBe(true);
	});
});
