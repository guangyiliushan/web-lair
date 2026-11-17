import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretError } from './errors.ts';

/**
 * Envelope encryption for DB-stored runtime credentials: AES-256-GCM from
 * `node:crypto` — zero dependencies, FIPS-available on every Node build this
 * app deploys on. A fresh 12-byte IV is generated per write; the 16-byte
 * authentication tag and the ciphertext are stored alongside it.
 * Ciphertext format (self-describing, versioned):
 * `v1:<keyVersion>:<ivBase64url>:<tagBase64url>:<ciphertextBase64url>`.
 * `<keyVersion>` selects the master key from the keyring; the leading `v1`
 * is the format version and leaves room for an algorithm change without
 * reinterpreting old rows. AAD binds a value to its row
 * (`<table>:<id>:<field>`), so a ciphertext copied into another row fails
 * the tag check instead of decrypting someone else's secret.
 * This module deliberately has no `$lib`/`$env` imports: the job drain loads
 * it under plain Node with type stripping (same rule as `src/lib/server/ai/*`).
 */

export const CIPHERTEXT_FORMAT_VERSION = 'v1';
export const SECRET_KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

/** Resolves a key version to raw key bytes; `null` means the keyring lacks it. */
export type SecretKeyResolver = (keyVersion: number) => Buffer | null;

export interface DecryptedSecret {
	plaintext: string;
	keyVersion: number;
}

function assertKey(key: Buffer, label: string): void {
	if (!Buffer.isBuffer(key) || key.length !== SECRET_KEY_BYTES) {
		// A wrong-length key is a deployment mistake, not attacker input: fail
		// as a programming error so it cannot be swallowed as `decrypt_failed`.
		throw new Error(`${label} must be ${SECRET_KEY_BYTES} bytes (got ${key.length})`);
	}
}

/** AAD shape used by every caller; exported so tests and callers cannot drift. */
export function secretAad(table: string, id: string, field: string): string {
	return `${table}:${id}:${field}`;
}

function encodePart(buffer: Buffer): string {
	return buffer.toString('base64url');
}

/** Strict base64url decode: Node's decoder silently ignores junk, this does not. */
function decodePart(part: string): Buffer {
	if (part.length === 0 || !/^[A-Za-z0-9_-]+$/.test(part)) {
		throw new SecretError('decrypt_failed', 'Ciphertext envelope contains a malformed part');
	}
	const buffer = Buffer.from(part, 'base64url');
	if (buffer.length === 0 || buffer.toString('base64url') !== part) {
		throw new SecretError('decrypt_failed', 'Ciphertext envelope contains a non-canonical part');
	}
	return buffer;
}

interface ParsedEnvelope {
	keyVersion: number;
	iv: Buffer;
	tag: Buffer;
	ciphertext: Buffer;
}

/**
 * Parse `<format>:<keyVersion>:<iv>:<tag>:<ct>`. Format errors are reported as
 * `decrypt_failed` on purpose: a caller cannot distinguish "someone edited the
 * column" from "wrong key", and both must fail closed rather than fall back.
 */
function parseEnvelope(value: string): ParsedEnvelope {
	const parts = value.split(':');
	if (parts.length !== 5 || parts[0] !== CIPHERTEXT_FORMAT_VERSION) {
		throw new SecretError('decrypt_failed', 'Ciphertext is not a v1 secret envelope');
	}
	const keyVersionRaw = parts[1];
	if (!/^[1-9][0-9]{0,8}$/.test(keyVersionRaw)) {
		throw new SecretError('decrypt_failed', 'Ciphertext envelope has an invalid key version');
	}
	const keyVersion = Number(keyVersionRaw);
	const iv = decodePart(parts[2]);
	const tag = decodePart(parts[3]);
	const ciphertext = decodePart(parts[4]);
	if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
		throw new SecretError('decrypt_failed', 'Ciphertext envelope has an invalid IV or tag length');
	}
	return { keyVersion, iv, tag, ciphertext };
}

/** Encrypt one value; returns the self-describing envelope string. */
export function encryptSecret(
	plaintext: string,
	key: Buffer,
	keyVersion: number,
	aad: string
): string {
	assertKey(key, 'secret key');
	if (!Number.isInteger(keyVersion) || keyVersion < 1) {
		throw new Error(`keyVersion must be a positive integer (got ${keyVersion})`);
	}
	if (plaintext.length === 0) {
		// Never store an empty credential: "configured but blank" must be a row
		// that does not exist, otherwise `missing` and `decrypt_failed` blur.
		throw new Error('refusing to encrypt an empty secret');
	}
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(aad, 'utf8'));
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [
		CIPHERTEXT_FORMAT_VERSION,
		String(keyVersion),
		encodePart(iv),
		encodePart(tag),
		encodePart(ciphertext)
	].join(':');
}

/**
 * Decrypt one envelope. `resolveKey` returns the raw key for the version named
 * inside the ciphertext; `null` raises `unknown_key_version` (terminal - the
 * row cannot be read by this deployment, and no other source is consulted).
 */
export function decryptSecret(
	value: string,
	resolveKey: SecretKeyResolver,
	aad: string
): DecryptedSecret {
	const { keyVersion, iv, tag, ciphertext } = parseEnvelope(value);
	const key = resolveKey(keyVersion);
	if (!key) {
		throw new SecretError(
			'unknown_key_version',
			`No master key for version ${keyVersion} in the keyring`
		);
	}
	assertKey(key, 'secret key');
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAAD(Buffer.from(aad, 'utf8'));
		decipher.setAuthTag(tag);
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
			'utf8'
		);
		return { plaintext, keyVersion };
	} catch {
		// Wrong key, edited ciphertext, moved row (AAD mismatch) - all identical
		// from here. Never leak the underlying OpenSSL message.
		throw new SecretError('decrypt_failed', 'Secret failed authentication (wrong key or AAD)');
	}
}

/** The key version inside a ciphertext, without decrypting it (listing/rotation). */
export function ciphertextKeyVersion(value: string): number {
	return parseEnvelope(value).keyVersion;
}
