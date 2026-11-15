import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Argon2id KDF shared by the note gate and the account password credential.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum profile
 * (m=19456 KiB, t=2, p=1, 16 B salt, 32 B tag) and run through the Node 24
 * `crypto.argon2` implementation on the libuv thread pool. Storage is a
 * self-describing PHC string, so a future parameter bump keeps existing rows
 * verifiable without a schema migration.
 */
export const ARGON2_MEMORY_KIB = 19456;
export const ARGON2_PASSES = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_TAG_LENGTH = 32;
export const ARGON2_SALT_LENGTH = 16;
const ARGON2_ID = 'argon2id';

type Argon2Options = {
	message: Buffer;
	nonce: Buffer;
	tagLength: number;
	memory: number;
	passes: number;
	parallelism: number;
};

const argon2Async = promisify(argon2) as (
	algorithm: string,
	options: Argon2Options
) => Promise<Buffer>;

/** True when a stored hash is an Argon2id PHC string (vs. legacy scrypt). */
export function isArgon2idPhc(hash: string): boolean {
	return hash.startsWith('$argon2id$');
}

/** PHC string for a password (the only place new hashes are created). */
export async function hashArgon2id(password: string): Promise<string> {
	const salt = randomBytes(ARGON2_SALT_LENGTH);
	const tag = await argon2Async(ARGON2_ID, {
		message: Buffer.from(password, 'utf8'),
		nonce: salt,
		tagLength: ARGON2_TAG_LENGTH,
		memory: ARGON2_MEMORY_KIB,
		passes: ARGON2_PASSES,
		parallelism: ARGON2_PARALLELISM
	});
	return `$argon2id$v=19$m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${salt.toString('base64')}$${tag.toString('base64')}`;
}

export interface ParsedArgon2idPhc {
	salt: Buffer;
	tag: Buffer;
	memory: number;
	passes: number;
	parallelism: number;
}

/**
 * Parse a PHC string into verifiable parts. Only the shape we emit is
 * accepted, and the cost parameters are floored at the current minimum:
 * a weak-parameter row from outside the write path must not get a cheap
 * verification pass.
 */
export function parseArgon2idPhc(phc: string): ParsedArgon2idPhc | null {
	const parts = phc.split('$');
	// ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', <salt b64>, <tag b64>]
	if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'argon2id') return null;
	if (parts[2] !== 'v=19') return null;
	const params = new Map<string, string>();
	for (const pair of parts[3].split(',')) {
		const [key, value] = pair.split('=');
		if (key && value !== undefined) params.set(key, value);
	}
	const memory = Number(params.get('m'));
	const passes = Number(params.get('t'));
	const parallelism = Number(params.get('p'));
	if (!Number.isFinite(memory) || memory < ARGON2_MEMORY_KIB) return null;
	if (!Number.isFinite(passes) || passes < ARGON2_PASSES) return null;
	if (!Number.isInteger(parallelism) || parallelism < 1) return null;
	// Upper bounds are a DoS guard for a stored row with absurd cost params;
	// the floors keep weak rows from getting a cheap verification pass.
	if (memory > 262_144 || passes > 10 || parallelism > 8) return null;
	try {
		const salt = Buffer.from(parts[4], 'base64');
		const tag = Buffer.from(parts[5], 'base64');
		if (salt.length < 8 || tag.length < 16) return null;
		return { salt, tag, memory, passes, parallelism };
	} catch {
		return null;
	}
}

/** Constant-time password check against a stored Argon2id PHC string. */
export async function verifyArgon2id(password: string, phc: string): Promise<boolean> {
	const parsed = parseArgon2idPhc(phc);
	if (!parsed) return false;
	const computed = await argon2Async(ARGON2_ID, {
		message: Buffer.from(password, 'utf8'),
		nonce: parsed.salt,
		tagLength: parsed.tag.length,
		memory: parsed.memory,
		passes: parsed.passes,
		parallelism: parsed.parallelism
	});
	return timingSafeEqual(computed, parsed.tag);
}
