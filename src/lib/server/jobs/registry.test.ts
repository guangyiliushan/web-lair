import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBuiltinLoader, isSafeJobName } from './loader';
import { JOBS, builtinModuleFile } from './registry';

describe('registry', () => {
	it('every entry is self-consistent and has a builtin module on disk', async () => {
		const dir = fileURLToPath(new URL('./builtin', import.meta.url));
		const files = (await readdir(dir)).filter((file) => file.endsWith('.ts')).sort();
		expect(files).toEqual(Object.keys(JOBS).map(builtinModuleFile).sort());
		for (const [key, definition] of Object.entries(JOBS)) {
			expect(definition.name).toBe(key);
			expect(definition.timeoutMs).toBeGreaterThan(0);
			expect(definition.description.length).toBeGreaterThan(0);
			expect(isSafeJobName(key)).toBe(true);
		}
	});

	it('maps dotted names to dashed module files', () => {
		expect(builtinModuleFile('jobs.prune')).toBe('jobs-prune.ts');
		expect(builtinModuleFile('system.resources')).toBe('system-resources.ts');
	});
});

describe('isSafeJobName', () => {
	it('accepts dotted registry names and rejects path-shaped ones', () => {
		expect(isSafeJobName('jobs.prune')).toBe(true);
		expect(isSafeJobName('system.resources')).toBe(true);
		expect(isSafeJobName('a-b.c')).toBe(true);
		// Path escape attempts must never reach the filesystem (J-2 feeds this
		// from files).
		expect(isSafeJobName('../evil')).toBe(false);
		expect(isSafeJobName('%2e%2e/evil')).toBe(false);
		expect(isSafeJobName('a/b')).toBe(false);
		expect(isSafeJobName('-leading')).toBe(false);
	});

	it('rejects Windows device names as stems (con.ts is the console)', () => {
		expect(isSafeJobName('con')).toBe(false);
		expect(isSafeJobName('nul')).toBe(false);
		expect(isSafeJobName('lpt9')).toBe(false);
		// Only the MAPPED stem matters: dots become dashes.
		expect(isSafeJobName('a.con')).toBe(true);
		expect(isSafeJobName('con.worker')).toBe(true);
	});
});

describe('createBuiltinLoader', () => {
	// 60s: the dynamic import goes through Vite's module runner, which is slow
	// under full-suite load (the 5s default, and even 30s while other suites
	// ran concurrently, turned this into a false red; solo it takes seconds).
	it('loads each builtin and hashes the executing file', async () => {
		const load = createBuiltinLoader();
		for (const name of Object.keys(JOBS)) {
			const loaded = await load(name);
			const bytes = await readFile(
				fileURLToPath(new URL(`./builtin/${builtinModuleFile(name)}`, import.meta.url))
			);
			expect(loaded.sourceHash).toBe(createHash('sha256').update(bytes).digest('hex'));
			expect(typeof loaded.run).toBe('function');
		}
	}, 60_000);

	it('rejects unknown jobs', async () => {
		await expect(createBuiltinLoader()('ghost.job')).rejects.toThrow('unknown job');
	});
});
