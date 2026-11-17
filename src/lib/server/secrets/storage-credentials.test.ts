import { describe, expect, it } from 'vitest';
import { parseKeyring } from './keyring';
import { encryptSecret, secretAad } from './crypto';
import { SecretError } from './errors';
import type { SecretDb } from './resolver';
import {
	StorageCredentialError,
	clearStorageCredentials,
	normalizeStorageCredentialInput,
	readStorageCredentialStatus,
	resolveStorageCredentials,
	saveStorageCredentials,
	type StorageSecretWriteDb
} from './storage-credentials';

/**
 * Storage credential store: db-first, env fallback only when no row
 * exists, terminal failure on a bad envelope, write-only in practice (the
 * plaintext never round-trips through any read helper the UI uses).
 */
const K1 = Buffer.alloc(32, 0x11);
const K2 = Buffer.alloc(32, 0x22);
const KEYRING = parseKeyring({ keys: `1:${K1.toString('base64')}`, active: '1' });
const OTHER_KEYRING = parseKeyring({ keys: `2:${K2.toString('base64')}`, active: '2' });
const ACCESS = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const ENV = {
	STORAGE_S3_ACCESS_KEY: ACCESS,
	STORAGE_S3_SECRET_KEY: SECRET
};
const deps = (env: Record<string, string | undefined> = {}) => ({
	getEnv: (name: string) => env[name],
	keyring: KEYRING
});

function encryptedRow(ring = KEYRING) {
	const key = ring.resolve(ring.activeVersion)!;
	return {
		accessKeyCiphertext: encryptSecret(
			ACCESS,
			key,
			ring.activeVersion,
			secretAad('storage_secrets', 's3', 'access_key_ciphertext')
		),
		accessKeyHint: 'AKIA…MPLE',
		accessKeyKeyVersion: ring.activeVersion,
		secretCiphertext: encryptSecret(
			SECRET,
			key,
			ring.activeVersion,
			secretAad('storage_secrets', 's3', 'secret_ciphertext')
		),
		secretHint: 'wJal…MPLE',
		secretKeyVersion: ring.activeVersion,
		updatedAt: new Date('2026-11-14T10:00:00.000Z')
	};
}

function readDb(rows: unknown[] | (() => never)) {
	return {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => {
						if (typeof rows === 'function') rows();
						return rows;
					}
				})
			})
		})
	} as unknown as SecretDb;
}

describe('storage credentials resolver', () => {
	it('falls back to the environment when no row exists', async () => {
		await expect(resolveStorageCredentials(readDb([]), deps(ENV))).resolves.toEqual({
			accessKeyId: ACCESS,
			secretAccessKey: SECRET,
			source: 'env'
		});
	});

	it('resolves null when neither source is configured', async () => {
		await expect(resolveStorageCredentials(readDb([]), deps({}))).resolves.toBeNull();
	});

	it('decrypts a stored pair', async () => {
		await expect(resolveStorageCredentials(readDb([encryptedRow()]), deps(ENV))).resolves.toEqual({
			accessKeyId: ACCESS,
			secretAccessKey: SECRET,
			source: 'db'
		});
	});

	it('never falls back to env when the row cannot be decrypted', async () => {
		// The row was written under key version 2; this keyring only has 1.
		await expect(
			resolveStorageCredentials(readDb([encryptedRow(OTHER_KEYRING)]), deps(ENV))
		).rejects.toMatchObject({ name: 'SecretError', code: 'unknown_key_version' });
	});

	it('rejects a tampered ciphertext', async () => {
		const row = encryptedRow();
		row.secretCiphertext = row.secretCiphertext.replace(/.$/, (char) => (char === 'A' ? 'B' : 'A'));
		await expect(resolveStorageCredentials(readDb([row]), deps(ENV))).rejects.toBeInstanceOf(
			SecretError
		);
	});

	it('reports a broken store as unavailable instead of throwing', async () => {
		const db = readDb(() => {
			throw new Error('relation "storage_secrets" does not exist');
		});
		await expect(readStorageCredentialStatus(db, deps(ENV))).resolves.toMatchObject({
			source: 'unavailable'
		});
		// The runtime path does fail closed.
		await expect(resolveStorageCredentials(db, deps(ENV))).rejects.toMatchObject({
			code: 'store_unavailable'
		});
	});
});

describe('storage credential status', () => {
	it('shows hints only for a db row', async () => {
		await expect(readStorageCredentialStatus(readDb([encryptedRow()]), deps())).resolves.toEqual({
			source: 'db',
			accessHint: 'AKIA…MPLE',
			secretHint: 'wJal…MPLE',
			keyVersion: 1,
			updatedAt: new Date('2026-11-14T10:00:00.000Z')
		});
	});

	it('shows the env reference (masked) when the row is absent', async () => {
		const status = await readStorageCredentialStatus(readDb([]), deps(ENV));
		expect(status.source).toBe('env');
		expect(status.accessHint).toMatch(/^AKIA…/);
		expect(status.accessHint).not.toContain(SECRET);
		expect(status.secretHint).toBeNull();
	});

	it('reports missing when nothing is configured', async () => {
		await expect(readStorageCredentialStatus(readDb([]), deps())).resolves.toMatchObject({
			source: 'missing'
		});
	});
});

describe('storage credential writes', () => {
	function writeDb() {
		const captured: {
			values?: Record<string, unknown>;
			upsert?: Record<string, unknown>;
			deleted?: unknown;
		} = {};
		const db = {
			insert: () => ({
				values: (values: Record<string, unknown>) => ({
					onConflictDoUpdate: async (config: { set: Record<string, unknown> }) => {
						captured.values = values;
						captured.upsert = config.set;
					}
				})
			}),
			delete: () => ({
				where: async (condition: unknown) => {
					captured.deleted = condition;
				}
			})
		};
		return { db: db as unknown as StorageSecretWriteDb, captured };
	}

	it('stores ciphertext + hints and never the plaintext', async () => {
		const { db, captured } = writeDb();

		const result = await saveStorageCredentials(
			db,
			{ accessKeyId: ` ${ACCESS} `, secretAccessKey: SECRET },
			{ actorId: 'user-1', deps: deps() }
		);

		expect(result.keyVersion).toBe(1);
		expect(captured.values).toMatchObject({
			id: 's3',
			accessKeyHint: 'AKIA…MPLE',
			accessKeyKeyVersion: 1,
			secretKeyVersion: 1,
			updatedBy: 'user-1'
		});
		const serialized = JSON.stringify(captured.values);
		expect(serialized).not.toContain(ACCESS);
		expect(serialized).not.toContain(SECRET);
		expect(String(captured.values?.accessKeyCiphertext)).toMatch(/^v1:1:/);
		// The rotation path is the UPDATE half: it must carry the new envelopes,
		// hints and key versions, not just touch the row.
		expect(captured.upsert).toMatchObject({
			accessKeyHint: 'AKIA…MPLE',
			accessKeyKeyVersion: 1,
			secretKeyVersion: 1,
			updatedBy: 'user-1'
		});
		expect(String(captured.upsert?.accessKeyCiphertext)).toMatch(/^v1:1:/);
		expect(String(captured.upsert?.secretCiphertext)).toMatch(/^v1:1:/);
		expect(captured.upsert?.updatedAt).toBeInstanceOf(Date);
	});

	it('rejects an empty or whitespace-bearing pair before touching the store', async () => {
		const { db, captured } = writeDb();

		await expect(
			saveStorageCredentials(
				db,
				{ accessKeyId: '', secretAccessKey: '' },
				{ actorId: null, deps: deps() }
			)
		).rejects.toMatchObject({ name: 'StorageCredentialError', reason: 'missing' });
		await expect(
			saveStorageCredentials(
				db,
				{ accessKeyId: 'AKIA WITH SPACE', secretAccessKey: SECRET },
				{ actorId: null, deps: deps() }
			)
		).rejects.toMatchObject({ reason: 'whitespace' });
		expect(captured.values).toBeUndefined();
	});

	it('fails when the keyring has no active key', async () => {
		const { db } = writeDb();
		const emptyRing = parseKeyring({ keys: `1:${K1.toString('base64')}`, active: '1' });
		await expect(
			saveStorageCredentials(
				db,
				{ accessKeyId: ACCESS, secretAccessKey: SECRET },
				{ actorId: null, deps: { getEnv: () => undefined, keyring: emptyRing } }
			)
		).resolves.toEqual({ keyVersion: 1 });

		const missingKeyRing = { ...emptyRing, activeVersion: 9, resolve: () => null };
		await expect(
			saveStorageCredentials(
				db,
				{ accessKeyId: ACCESS, secretAccessKey: SECRET },
				{ actorId: null, deps: { getEnv: () => undefined, keyring: missingKeyRing as never } }
			)
		).rejects.toMatchObject({ code: 'store_unavailable' });
	});

	it('clears the singleton row', async () => {
		const { db, captured } = writeDb();
		await clearStorageCredentials(db);
		expect(captured.deleted).toBeDefined();
	});

	it('bounds the input shape', () => {
		expect(normalizeStorageCredentialInput({ accessKeyId: ' a ', secretAccessKey: ' b ' })).toEqual(
			{
				accessKeyId: 'a',
				secretAccessKey: 'b'
			}
		);
		expect(() =>
			normalizeStorageCredentialInput({ accessKeyId: 'a'.repeat(300), secretAccessKey: 'b' })
		).toThrow(StorageCredentialError);
	});
});
