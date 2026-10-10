import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { jobsDir, repoRoot, resolveDataDir } from './data-dir';

describe('resolveDataDir', () => {
	it('uses an absolute DATA_DIR as-is', () => {
		expect(resolveDataDir({ DATA_DIR: 'D:/wl-data' })).toBe('D:/wl-data');
	});

	it('resolves a relative DATA_DIR against cwd', () => {
		expect(resolveDataDir({ DATA_DIR: 'rel/dir' })).toBe(resolve('rel/dir'));
	});

	it('trims whitespace and ignores a blank DATA_DIR', () => {
		expect(resolveDataDir({ DATA_DIR: '  ' })).toBe(resolve(repoRoot, 'data'));
		expect(resolveDataDir({ DATA_DIR: ' ./x ' })).toBe(resolve('./x'));
	});

	it('defaults to <repo>/data without consulting cwd', () => {
		expect(resolveDataDir({})).toBe(resolve(repoRoot, 'data'));
		expect(isAbsolute(repoRoot)).toBe(true);
	});
});

describe('jobsDir', () => {
	it('appends the jobs segment', () => {
		expect(jobsDir('D:/wl-data')).toBe(join('D:/wl-data', 'jobs'));
	});
});

describe('repoRoot discovery (J-2 review F4/R16)', () => {
	it('resolves to a directory that carries the repo markers', () => {
		expect(isAbsolute(repoRoot)).toBe(true);
		expect(existsSync(join(repoRoot, 'package.json'))).toBe(true);
		expect(existsSync(join(repoRoot, 'src', 'lib', 'server', 'jobs', 'sdk-facade.d.ts'))).toBe(
			true
		);
	});

	it('honors the JOBS_REPO_ROOT override for relocated deployments', async () => {
		const previous = process.env.JOBS_REPO_ROOT;
		process.env.JOBS_REPO_ROOT = 'D:/custom-root';
		try {
			vi.resetModules();
			const fresh = await import('./data-dir');
			expect(fresh.repoRoot).toBe(resolve('D:/custom-root'));
		} finally {
			if (previous === undefined) delete process.env.JOBS_REPO_ROOT;
			else process.env.JOBS_REPO_ROOT = previous;
			vi.resetModules();
		}
	});
});
