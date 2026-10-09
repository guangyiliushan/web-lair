import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
