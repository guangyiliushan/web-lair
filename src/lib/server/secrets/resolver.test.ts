import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SecretError } from './errors.ts';
import { parseKeyring } from './keyring.ts';
import {
	encryptProviderKeyValue,
	envNamesWithDatabaseKeys,
	providerKeyHint,
	readProviderKeyStatuses,
	resolveProviderKey,
	type SecretDb
} from './resolver.ts';

const KEY = Buffer.alloc(32, 0x33);
const RING = parseKeyring({ keys: `1:${KEY.toString('base64')}`, active: '1' });

const PROVIDER_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_ID = '55555555-5555-5555-5555-555555555555';

function dbWithRows(rows: unknown[]): SecretDb {
	const chain = {
		from: () => ({
			where: () => {
				const promise = Promise.resolve(rows);
				return Object.assign(promise, { limit: async () => rows });
			}
		})
	};
	return { select: () => chain } as unknown as SecretDb;
}

function failingDb(error: Error): SecretDb {
	return {
		select: () => ({
			from: () => ({
				where: () => {
					const promise = Promise.reject(error);
					promise.catch(() => {});
					return Object.assign(promise, {
						limit: async () => {
							throw error;
						}
					});
				}
			})
		})
	} as unknown as SecretDb;
}

function secretRow(providerId: string, value: string, hint = 'sk-…AbCd') {
	const encrypted = encryptProviderKeyValue(providerId, value, RING);
	return {
		providerId,
		ciphertext: encrypted.ciphertext,
		hint,
		keyVersion: encrypted.keyVersion,
		updatedAt: new Date('2026-11-13T00:00:00Z')
	};
}

const deps = (entries: Record<string, string> = {}, keyring = RING) => ({
	getEnv: (name: string) => entries[name],
	keyring
});

describe('resolveProviderKey', () => {
	it('prefers the encrypted row over the environment', async () => {
		const row = secretRow(PROVIDER_ID, 'db-secret');
		const resolved = await resolveProviderKey(
			dbWithRows([row]),
			{ id: PROVIDER_ID, apiKeyEnv: 'AI_TEST_KEY' },
			deps({ AI_TEST_KEY: 'env-secret' })
		);
		expect(resolved).toMatchObject({ value: 'db-secret', source: 'db', keyVersion: 1 });
		expect(resolved.hint).toBe('sk-…AbCd');
	});

	it('reports the version authenticated by the envelope, not the mirrored column', async () => {
		const row = { ...secretRow(PROVIDER_ID, 'db-secret'), keyVersion: 9 };
		const resolved = await resolveProviderKey(dbWithRows([row]), { id: PROVIDER_ID }, deps());
		expect(resolved.keyVersion).toBe(1);
	});

	it('scopes the read to the requested provider row', async () => {
		const seen: unknown[] = [];
		const db = {
			select: () => ({
				from: () => ({
					where: (condition: unknown) => {
						seen.push(condition);
						const promise = Promise.resolve([]);
						return Object.assign(promise, { limit: async () => [] });
					}
				})
			})
		} as unknown as SecretDb;
		await expect(
			resolveProviderKey(
				db,
				{ id: PROVIDER_ID, apiKeyEnv: 'AI_TEST_KEY' },
				deps({ AI_TEST_KEY: 'x' })
			)
		).resolves.toMatchObject({ source: 'env' });
		expect(seen).toHaveLength(1);
		const query = new PgDialect().sqlToQuery(seen[0] as never);
		expect(query.sql).toContain('"ai_provider_secrets"."provider_id"');
		expect(query.params).toContain(PROVIDER_ID);
	});

	it('falls back to the env name only when no row exists', async () => {
		const resolved = await resolveProviderKey(
			dbWithRows([]),
			{ id: PROVIDER_ID, apiKeyEnv: 'AI_TEST_KEY' },
			deps({ AI_TEST_KEY: 'env-secret' })
		);
		expect(resolved).toEqual({
			value: 'env-secret',
			source: 'env',
			hint: null,
			keyVersion: null
		});
	});

	it('reports missing when neither source answers (empty env counts as unset)', async () => {
		const cases: Record<string, string>[] = [{}, { AI_TEST_KEY: '' }];
		for (const entries of cases) {
			try {
				await resolveProviderKey(
					dbWithRows([]),
					{ id: PROVIDER_ID, apiKeyEnv: 'AI_TEST_KEY' },
					deps(entries)
				);
				throw new Error('expected a SecretError');
			} catch (caught) {
				expect(caught).toBeInstanceOf(SecretError);
				expect((caught as SecretError).code).toBe('missing');
			}
		}
	});

	it('skips the database for an unsaved provider (no id)', async () => {
		const select = vi.fn();
		const db = { select } as unknown as SecretDb;
		const resolved = await resolveProviderKey(
			db,
			{ apiKeyEnv: 'AI_TEST_KEY' },
			deps({ AI_TEST_KEY: 'env-only' })
		);
		expect(resolved.source).toBe('env');
		expect(select).not.toHaveBeenCalled();
	});

	it('fails closed on a decrypt failure (no env fallback)', async () => {
		const row = { ...secretRow(PROVIDER_ID, 'db-secret'), ciphertext: 'v1:1:AAAA:BBBB:CCCC' };
		try {
			await resolveProviderKey(
				dbWithRows([row]),
				{ id: PROVIDER_ID, apiKeyEnv: 'AI_TEST_KEY' },
				deps({ AI_TEST_KEY: 'env-secret' })
			);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect(caught).toBeInstanceOf(SecretError);
			expect((caught as SecretError).code).toBe('decrypt_failed');
		}
	});

	it('fails closed when the row names a version the keyring lacks', async () => {
		const encrypted = encryptProviderKeyValue(PROVIDER_ID, 'db-secret', RING);
		// Row written under version 1, read by a ring that only has version 2.
		const other = parseKeyring({
			keys: `2:${Buffer.alloc(32, 9).toString('base64')}`,
			active: '2'
		});
		try {
			await resolveProviderKey(
				dbWithRows([{ ...encrypted, updatedAt: new Date() }]),
				{ id: PROVIDER_ID, apiKeyEnv: 'AI_TEST_KEY' },
				deps({ AI_TEST_KEY: 'env-secret' }, other)
			);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect((caught as SecretError).code).toBe('unknown_key_version');
		}
	});

	it('binds a ciphertext to its provider row (AAD)', async () => {
		const encrypted = encryptProviderKeyValue(PROVIDER_ID, 'db-secret', RING);
		try {
			await resolveProviderKey(
				dbWithRows([{ ...encrypted, updatedAt: new Date() }]),
				{ id: OTHER_ID, apiKeyEnv: 'AI_TEST_KEY' },
				deps({ AI_TEST_KEY: 'env-secret' })
			);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect((caught as SecretError).code).toBe('decrypt_failed');
		}
	});

	it('reports a store failure instead of falling back to env', async () => {
		try {
			await resolveProviderKey(
				failingDb(new Error('relation does not exist')),
				{ id: PROVIDER_ID, apiKeyEnv: 'AI_TEST_KEY' },
				deps({ AI_TEST_KEY: 'env-secret' })
			);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect((caught as SecretError).code).toBe('store_unavailable');
		}
	});

	it('reports an unconfigured keyring as store_unavailable', async () => {
		const row = secretRow(PROVIDER_ID, 'db-secret');
		try {
			await resolveProviderKey(
				dbWithRows([row]),
				{ id: PROVIDER_ID },
				{
					getEnv: () => undefined
				}
			);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect((caught as SecretError).code).toBe('store_unavailable');
		}
	});

	it('decrypts a value written by the write helper (round trip)', async () => {
		const row = secretRow(PROVIDER_ID, 'round-trip-secret', 'sk-…WXYZ');
		const resolved = await resolveProviderKey(dbWithRows([row]), { id: PROVIDER_ID }, deps());
		expect(resolved.value).toBe('round-trip-secret');
		expect(resolved.hint).toBe('sk-…WXYZ');
	});
});

describe('provider key status helpers', () => {
	it('returns presence and hint for the UI, never the ciphertext', async () => {
		const row = secretRow(PROVIDER_ID, 'db-secret');
		const statuses = await readProviderKeyStatuses(dbWithRows([row]), [PROVIDER_ID]);
		expect(statuses.get(PROVIDER_ID)).toMatchObject({
			configured: true,
			hint: 'sk-…AbCd',
			keyVersion: 1
		});
		expect(Object.keys(statuses.get(PROVIDER_ID)!)).not.toContain('ciphertext');
	});

	it('degrades to an empty map on a store error', async () => {
		const statuses = await readProviderKeyStatuses(failingDb(new Error('nope')), [PROVIDER_ID]);
		expect(statuses.size).toBe(0);
	});

	it('maps env names only for providers with a DB key', async () => {
		const row = secretRow(PROVIDER_ID, 'db-secret');
		const names = await envNamesWithDatabaseKeys(dbWithRows([row]), [
			{ id: PROVIDER_ID, apiKeyEnv: 'AI_ONE_KEY' },
			{ id: OTHER_ID, apiKeyEnv: 'AI_TWO_KEY' }
		]);
		expect([...names]).toEqual(['AI_ONE_KEY']);
	});

	it('builds a hint that keeps only a short prefix and the last four characters', () => {
		expect(providerKeyHint('sk-proj-1234567890abcd')).toBe('sk-…abcd');
		expect(providerKeyHint('abcdefghijklmnop')).toBe('…mnop');
		expect(providerKeyHint('abcdefghijkl')).toBe('…kl');
		expect(providerKeyHint('abcd12345')).toBe('…45');
		expect(providerKeyHint('short')).toBe('…rt');
		expect(providerKeyHint('abc')).toBe('…bc');
		expect(providerKeyHint('a')).toBe('…');
	});
});
