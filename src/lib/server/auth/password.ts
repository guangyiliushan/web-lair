import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '$env/dynamic/private';
import { hashArgon2id, isArgon2idPhc, verifyArgon2id } from '$lib/server/security/argon2';

/**
 * Password hashing for the better-auth credential account (W8.8 / S1-D).
 *
 * New hashes are Argon2id via the official `emailAndPassword.password`
 * hash/verify hooks - no auth-table change. Verification accepts both the
 * Argon2id PHC format and the legacy better-auth scrypt format
 * (`saltHex:keyHex`), so a rollout never locks out existing accounts. A
 * legacy hash is rewritten the next time the password is changed; there is no
 * silent rehash hook in better-auth.
 *
 * Rollback: set `PASSWORD_HASH_ALGO=scrypt`. New hashes return to the legacy
 * format while the verifier keeps accepting Argon2id rows, so rollback does
 * not lock anyone out.
 */
export type AccountPasswordAlgorithm = 'argon2id' | 'scrypt';

/** better-auth's legacy scrypt profile (salt 16 B, 64 B derived key). */
const SCRYPT = { N: 16384, r: 16, p: 1, dkLen: 64 } as const;
const SCRYPT_SALT_BYTES = 16;

const scryptAsync = promisify(scrypt) as (
	password: string,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

export function accountPasswordAlgorithm(
	getEnv: (name: string) => string | undefined = (name) => env[name]
): AccountPasswordAlgorithm {
	return getEnv('PASSWORD_HASH_ALGO')?.trim().toLowerCase() === 'scrypt' ? 'scrypt' : 'argon2id';
}

async function hashScrypt(password: string): Promise<string> {
	const salt = randomBytes(SCRYPT_SALT_BYTES);
	const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT.dkLen, {
		N: SCRYPT.N,
		r: SCRYPT.r,
		p: SCRYPT.p,
		maxmem: 128 * SCRYPT.N * SCRYPT.r * 2
	});
	return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyScrypt(password: string, hash: string): Promise<boolean> {
	const [saltHex, keyHex] = hash.split(':');
	if (!saltHex || !keyHex) return false;
	// Reject anything that is not a hex-encoded 16-byte salt / 64-byte key:
	// Buffer.from(..., 'hex') silently truncates invalid input.
	if (!/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(keyHex)) return false;
	const expected = Buffer.from(keyHex, 'hex');
	const derived = await scryptAsync(
		password.normalize('NFKC'),
		Buffer.from(saltHex, 'hex'),
		SCRYPT.dkLen,
		{
			N: SCRYPT.N,
			r: SCRYPT.r,
			p: SCRYPT.p,
			maxmem: 128 * SCRYPT.N * SCRYPT.r * 2
		}
	);
	return timingSafeEqual(derived, expected);
}

/** New credential hash; switched by `PASSWORD_HASH_ALGO` for rollback. */
export async function hashAccountPassword(
	password: string,
	getEnv?: (name: string) => string | undefined
): Promise<string> {
	return accountPasswordAlgorithm(getEnv) === 'scrypt'
		? hashScrypt(password)
		: hashArgon2id(password);
}

/**
 * Verify a presented password against the stored credential hash. Format
 * detection (not the env switch) decides the algorithm, so legacy and new
 * rows both keep working in either mode.
 */
export async function verifyAccountPassword(data: {
	hash: string;
	password: string;
}): Promise<boolean> {
	if (isArgon2idPhc(data.hash)) return verifyArgon2id(data.password, data.hash);
	return verifyScrypt(data.password, data.hash);
}
