import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bindJobDb, requireBoundDb } from './sdk-binding';
import type { JobsDb } from './types';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const FACADE = join(repoRoot, 'src', 'lib', 'server', 'jobs', 'sdk-facade.d.ts');

/**
 * Value-level (`export declare`) names in the facade. Type-only declarations
 * (`export interface` / `export type`) have no runtime counterpart and are
 * excluded by construction.
 */
function declaredValueNames(source: string): string[] {
	const names = new Set<string>();
	for (const match of source.matchAll(/export declare (?:function|const|let|var|class) (\w+)/g)) {
		names.add(match[1]);
	}
	return [...names].sort();
}

describe('jobs SDK facade parity', { timeout: 30_000 }, () => {
	it('runtime exports and facade declarations match in both directions', async () => {
		const runtime = await import('./jobs-sdk');
		const runtimeNames = Object.keys(runtime).sort();
		const facade = await readFile(FACADE, 'utf8');
		expect(runtimeNames).toEqual(declaredValueNames(facade));
	});
});

describe('sdk-binding', () => {
	afterEach(() => bindJobDb(null));

	it('throws a clear error when nothing is bound', () => {
		expect(() => requireBoundDb()).toThrowError(/no database is bound/);
	});

	it('returns the bound client and clears on null', () => {
		const fake = { marker: true } as unknown as JobsDb;
		bindJobDb(fake);
		expect(requireBoundDb()).toBe(fake);
		bindJobDb(null);
		expect(() => requireBoundDb()).toThrow();
	});

	it('the db proxy delegates reads and guards unbound access', async () => {
		const { db } = await import('./jobs-sdk');
		expect(() => db.select).toThrowError(/no database is bound/);
		const select = () => 'chained';
		bindJobDb({ select } as unknown as JobsDb);
		expect(db.select()).toBe('chained');
	});
});
