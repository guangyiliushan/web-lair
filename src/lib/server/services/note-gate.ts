import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2 } from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '$env/dynamic/private';
import { getOption } from '$lib/server/config/options-registry';

/**
 * Password gate for notes (N1 detail page; notes plan v0.4 §2.5, ledger
 * §13.9). KDF = argon2id at the OWASP-cheatsheet minimum recommendation
 * (m=19456 KiB, t=2, p=1, 16 B salt, 32 B tag), run through the promisified
 * Node 24 `crypto.argon2` (async, libuv threadpool - the unlock endpoint is
 * public and must not block the event loop). Storage is a self-describing
 * PHC string: m/t/p are all read back on verify, so a future parameter bump
 * keeps existing rows verifiable without a migration. Unlock tokens are
 * HMAC-signed with a key derived from BETTER_AUTH_SECRET via HKDF (zero new
 * env vars) and bind the CURRENT password hash — changing or removing the
 * password invalidates every outstanding unlock automatically.
 */

/** Argon2 parameters (OWASP Password Storage Cheat Sheet, minimum profile). */
export const ARGON2_MEMORY_KIB = 19456;
export const ARGON2_PASSES = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_TAG_LENGTH = 32;
export const ARGON2_SALT_LENGTH = 16;
const ARGON2_ID = 'argon2id';

/** Unlock cookie name prefix (per note row; the note id completes the name). */
export const NOTE_UNLOCK_COOKIE_PREFIX = 'wl_note_';

/** Failed-attempt budget for the unlock form (counted only on failure). */
export const NOTE_GATE_RATE_LIMIT = { limit: 5, windowSeconds: 60 } as const;

export function noteUnlockCookieName(noteId: string): string {
	return `${NOTE_UNLOCK_COOKIE_PREFIX}${noteId}`;
}

/**
 * Async KDF on the libuv threadpool (`crypto.argon2` is callback-based).
 * The unlock form is a PUBLIC endpoint: a synchronous argon2 (~39 ms at the
 * OWASP minimum profile) would block the event loop for the whole process
 * on every attempt (review finding), while the async form keeps concurrent
 * verifications off the main thread.
 */
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

/** PHC string for a password (write side; the only place hashes are created). */
export async function hashNotePassword(password: string): Promise<string> {
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

interface ParsedNotePhc {
	salt: Buffer;
	tag: Buffer;
	memory: number;
	passes: number;
	parallelism: number;
}

/**
 * Parse a PHC string into verifiable parts. Only the shape we emit is
 * accepted, and the cost parameters are floored at the current minimum:
 * a (hypothetical) weak-parameter row from outside the write path must
 * not get a cheap verification pass.
 */
function parseNotePhc(phc: string): ParsedNotePhc | null {
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
	// `p` is read from the string and USED for verification (floor 1): a
	// future constant bump must not make existing p=1 rows unverifiable
	// (review finding).
	const parallelism = Number(params.get('p'));
	if (!Number.isFinite(memory) || memory < ARGON2_MEMORY_KIB) return null;
	if (!Number.isFinite(passes) || passes < ARGON2_PASSES) return null;
	if (!Number.isInteger(parallelism) || parallelism < 1) return null;
	try {
		const salt = Buffer.from(parts[4], 'base64');
		const tag = Buffer.from(parts[5], 'base64');
		if (salt.length < 8 || tag.length < 16) return null;
		return { salt, tag, memory, passes, parallelism };
	} catch {
		return null;
	}
}

/** Constant-time password check against a stored PHC string. */
export async function verifyNotePassword(password: string, phc: string): Promise<boolean> {
	const parsed = parseNotePhc(phc);
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

const GATE_KEY_INFO = 'web-lair:notes-gate';

/**
 * HKDF-derived signing key (RFC 5869; domain-separated from every other
 * consumer of BETTER_AUTH_SECRET). Zero new environment variables; rotating
 * the auth secret invalidates all outstanding unlocks, which is acceptable
 * inside the 30-day TTL.
 */
function gateSigningKey(): Buffer {
	const secret = env.BETTER_AUTH_SECRET ?? '';
	if (!secret) {
		throw new Error('[note-gate] BETTER_AUTH_SECRET is not set; unlock tokens cannot be signed');
	}
	return Buffer.from(hkdfSync('sha256', secret, '', GATE_KEY_INFO, 32));
}

/**
 * Signed unlock token: `<expiresAt>.<base64url HMAC>`. The HMAC covers the
 * expiry, the note id AND the current password-hash fingerprint, so a
 * password change revokes every outstanding unlock for that row.
 */
export function signNoteUnlockToken(
	noteId: string,
	passwordHash: string,
	expiresAtSeconds: number
): string {
	const body = unlockTokenBody(noteId, passwordHash, expiresAtSeconds);
	const sig = createHmac('sha256', gateSigningKey()).update(body, 'utf8').digest('base64url');
	return `${expiresAtSeconds}.${sig}`;
}

function unlockTokenBody(noteId: string, passwordHash: string, expiresAtSeconds: number): string {
	const fingerprint = createHash('sha256').update(passwordHash, 'utf8').digest('hex');
	return `${expiresAtSeconds}.${noteId}.${fingerprint}`;
}

/** Verify an unlock token for a row (caller supplies the CURRENT stored hash). */
export function verifyNoteUnlockToken(
	noteId: string,
	passwordHash: string,
	token: string,
	now: Date = new Date()
): boolean {
	const dot = token.indexOf('.');
	if (dot <= 0) return false;
	const expiresAt = Number(token.slice(0, dot));
	const sig = token.slice(dot + 1);
	if (!Number.isFinite(expiresAt) || !sig) return false;
	if (expiresAt <= Math.floor(now.getTime() / 1000)) return false;

	const expected = createHmac('sha256', gateSigningKey())
		.update(unlockTokenBody(noteId, passwordHash, expiresAt), 'utf8')
		.digest('base64url');
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(sig, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Unlock cookie TTL from the `notes.gate` option (days → seconds). */
export async function noteGateTtlSeconds(): Promise<number> {
	const gate = await getOption('notes.gate');
	return gate.ttlDays * 86400;
}
