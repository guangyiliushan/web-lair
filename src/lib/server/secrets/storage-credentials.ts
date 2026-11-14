import { eq } from 'drizzle-orm';
import { STORAGE_SECRET_ID, storageSecrets } from '../db/system/storage-secret.schema.ts';
import { decryptSecret, encryptSecret, secretAad } from './crypto.ts';
import { SecretError } from './errors.ts';
import { loadKeyring, providerKeyHint, type SecretDb, type ResolveDeps } from './resolver.ts';

/**
 * External storage credentials (W7.6, decisions Q3/Q15).
 *
 * Read order, evaluated at call time (no cache — a cache needs invalidation,
 * and multi-replica invalidation is where the bugs live):
 *
 *     storage_secrets row  >  STORAGE_S3_ACCESS_KEY / STORAGE_S3_SECRET_KEY  >  missing
 *
 * Only "no row" may fall back to the environment. A row that exists but cannot
 * be decrypted is terminal: a wrong master key must be visible, not hidden
 * behind a stale env credential that still happens to work.
 *
 * Writes are write-only by construction: the UI posts a value, this module
 * encrypts it, and nothing ever reads the plaintext back out except the
 * adapter that signs requests. The hint columns are the only display fragments.
 */

export interface StorageCredentialStatus {
	/** `unavailable` = the store could not be read (pre-migration, DB down). */
	source: 'db' | 'env' | 'missing' | 'unavailable';
	accessHint: string | null;
	secretHint: string | null;
	keyVersion: number | null;
	updatedAt: Date | null;
}

export interface ResolvedStorageCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	source: 'db' | 'env';
}

interface StorageSecretRow {
	accessKeyCiphertext: string;
	accessKeyHint: string;
	accessKeyKeyVersion: number;
	secretCiphertext: string;
	secretHint: string;
	secretKeyVersion: number;
	updatedAt: Date;
}

const ENV_ACCESS = 'STORAGE_S3_ACCESS_KEY';
const ENV_SECRET = 'STORAGE_S3_SECRET_KEY';

async function readRow(db: SecretDb): Promise<StorageSecretRow | null> {
	let rows: StorageSecretRow[];
	try {
		rows = await db
			.select<StorageSecretRow>({
				accessKeyCiphertext: storageSecrets.accessKeyCiphertext,
				accessKeyHint: storageSecrets.accessKeyHint,
				accessKeyKeyVersion: storageSecrets.accessKeyKeyVersion,
				secretCiphertext: storageSecrets.secretCiphertext,
				secretHint: storageSecrets.secretHint,
				secretKeyVersion: storageSecrets.secretKeyVersion,
				updatedAt: storageSecrets.updatedAt
			})
			.from(storageSecrets)
			.where(eq(storageSecrets.id, STORAGE_SECRET_ID))
			.limit(1);
	} catch (error) {
		// Name only: a driver message can contain connection details.
		console.warn(
			'[secrets] storage credential store read failed',
			error instanceof Error ? error.name : 'unknown'
		);
		throw new SecretError('store_unavailable', 'Storage credential store unavailable');
	}
	return rows[0] ?? null;
}

function decryptField(
	value: string,
	field: 'access_key_ciphertext' | 'secret_ciphertext',
	deps: ResolveDeps
): { plaintext: string; keyVersion: number } {
	const keyring = loadKeyring(deps);
	return decryptSecret(
		value,
		keyring.resolve,
		secretAad('storage_secrets', STORAGE_SECRET_ID, field)
	);
}

/**
 * Status for the admin page. Never throws: a broken store shows as
 * `unavailable` instead of taking the page down, while the runtime path
 * (`resolveStorageCredentials`) still fails closed.
 */
export async function readStorageCredentialStatus(
	db: SecretDb,
	deps: ResolveDeps
): Promise<StorageCredentialStatus> {
	try {
		const row = await readRow(db);
		if (row) {
			return {
				source: 'db',
				accessHint: row.accessKeyHint,
				secretHint: row.secretHint,
				keyVersion: row.secretKeyVersion,
				updatedAt: row.updatedAt
			};
		}
	} catch {
		return {
			source: 'unavailable',
			accessHint: null,
			secretHint: null,
			keyVersion: null,
			updatedAt: null
		};
	}
	const envAccess = deps.getEnv(ENV_ACCESS)?.trim();
	const envSecret = deps.getEnv(ENV_SECRET)?.trim();
	if (envAccess && envSecret) {
		return {
			source: 'env',
			accessHint: providerKeyHint(envAccess),
			secretHint: null,
			keyVersion: null,
			updatedAt: null
		};
	}
	return {
		source: 'missing',
		accessHint: null,
		secretHint: null,
		keyVersion: null,
		updatedAt: null
	};
}

/**
 * Runtime credentials. Throws `SecretError` when a stored row cannot be read
 * or decrypted (terminal — no env fallback), resolves null when nothing is
 * configured at all.
 */
export async function resolveStorageCredentials(
	db: SecretDb,
	deps: ResolveDeps
): Promise<ResolvedStorageCredentials | null> {
	const row = await readRow(db);
	if (row) {
		const access = decryptField(row.accessKeyCiphertext, 'access_key_ciphertext', deps);
		const secret = decryptField(row.secretCiphertext, 'secret_ciphertext', deps);
		return { accessKeyId: access.plaintext, secretAccessKey: secret.plaintext, source: 'db' };
	}
	const envAccess = deps.getEnv(ENV_ACCESS)?.trim();
	const envSecret = deps.getEnv(ENV_SECRET)?.trim();
	if (envAccess && envSecret) {
		return { accessKeyId: envAccess, secretAccessKey: envSecret, source: 'env' };
	}
	return null;
}

/** Input contract for the write-only form: trimmed, bounded, non-empty. */
export interface StorageCredentialInput {
	accessKeyId: string;
	secretAccessKey: string;
}

export class StorageCredentialError extends Error {
	readonly reason: 'missing' | 'too-long' | 'whitespace';

	constructor(reason: 'missing' | 'too-long' | 'whitespace', message: string) {
		super(message);
		this.name = 'StorageCredentialError';
		this.reason = reason;
	}
}

export function normalizeStorageCredentialInput(
	input: StorageCredentialInput
): StorageCredentialInput {
	const accessKeyId = input.accessKeyId.trim();
	const secretAccessKey = input.secretAccessKey.trim();
	if (!accessKeyId || !secretAccessKey) {
		throw new StorageCredentialError('missing', 'Both credential fields are required');
	}
	if (accessKeyId.length > 256 || secretAccessKey.length > 512) {
		throw new StorageCredentialError('too-long', 'Credential value is too long');
	}
	// A newline/space inside a credential is almost always a paste accident;
	// rejecting it keeps the signed header unambiguous.
	if (/\s/.test(accessKeyId) || /\s/.test(secretAccessKey)) {
		throw new StorageCredentialError('whitespace', 'Credentials must not contain whitespace');
	}
	return { accessKeyId, secretAccessKey };
}

export interface EncryptedStorageCredential {
	ciphertext: string;
	hint: string;
	keyVersion: number;
}

/** Encrypt one half of the pair with the active key version and row AAD. */
export function encryptStorageCredential(
	field: 'access_key_ciphertext' | 'secret_ciphertext',
	value: string,
	keyring: ReturnType<typeof loadKeyring>
): EncryptedStorageCredential {
	const key = keyring.resolve(keyring.activeVersion);
	if (!key) {
		throw new SecretError(
			'store_unavailable',
			`Active key version ${keyring.activeVersion} is not present in the keyring`
		);
	}
	return {
		ciphertext: encryptSecret(
			value,
			key,
			keyring.activeVersion,
			secretAad('storage_secrets', STORAGE_SECRET_ID, field)
		),
		hint: providerKeyHint(value),
		keyVersion: keyring.activeVersion
	};
}

/** Structural write handle (the app db or a transaction satisfies it). */
export type StorageSecretWriteDb = Pick<typeof import('$lib/server/db').db, 'insert' | 'delete'>;

/**
 * Upsert the pair. A rotation is a plain replace: there is no grace window for
 * storage credentials (unlike webhook signing), because the adapter re-reads
 * on every request — an in-flight request either used the old value before the
 * write or the new one after it.
 */
export async function saveStorageCredentials(
	db: StorageSecretWriteDb,
	input: StorageCredentialInput,
	options: { actorId: string | null; deps: ResolveDeps }
): Promise<{ keyVersion: number }> {
	const normalized = normalizeStorageCredentialInput(input);
	const keyring = loadKeyring(options.deps);
	const access = encryptStorageCredential('access_key_ciphertext', normalized.accessKeyId, keyring);
	const secret = encryptStorageCredential('secret_ciphertext', normalized.secretAccessKey, keyring);

	await db
		.insert(storageSecrets)
		.values({
			id: STORAGE_SECRET_ID,
			accessKeyCiphertext: access.ciphertext,
			accessKeyHint: access.hint,
			accessKeyKeyVersion: access.keyVersion,
			secretCiphertext: secret.ciphertext,
			secretHint: secret.hint,
			secretKeyVersion: secret.keyVersion,
			updatedBy: options.actorId
		})
		.onConflictDoUpdate({
			target: storageSecrets.id,
			set: {
				accessKeyCiphertext: access.ciphertext,
				accessKeyHint: access.hint,
				accessKeyKeyVersion: access.keyVersion,
				secretCiphertext: secret.ciphertext,
				secretHint: secret.hint,
				secretKeyVersion: secret.keyVersion,
				updatedBy: options.actorId,
				updatedAt: new Date()
			}
		});
	return { keyVersion: secret.keyVersion };
}

/** Remove the stored pair (the env fallback becomes active again). */
export async function clearStorageCredentials(db: StorageSecretWriteDb): Promise<void> {
	await db.delete(storageSecrets).where(eq(storageSecrets.id, STORAGE_SECRET_ID));
}
