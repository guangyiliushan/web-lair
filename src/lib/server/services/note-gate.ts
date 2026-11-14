import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getOption } from '$lib/server/config/options-registry';
import { hashArgon2id, verifyArgon2id } from '$lib/server/security/argon2';

/**
 * Password gate for notes (N1 detail page; notes plan v0.4 §2.5, ledger
 * §13.9). The KDF is the shared Argon2id implementation in
 * `$lib/server/security/argon2` (OWASP minimum profile, async on the libuv
 * thread pool). Unlock tokens are HMAC-signed with a key derived from
 * BETTER_AUTH_SECRET via HKDF (zero new env vars) and bind the CURRENT note
 * password hash — changing or removing the note password invalidates every
 * outstanding unlock automatically.
 */

/** Re-exported for existing callers/tests that pin the KDF profile. */
export {
	ARGON2_MEMORY_KIB,
	ARGON2_PASSES,
	ARGON2_PARALLELISM,
	ARGON2_SALT_LENGTH,
	ARGON2_TAG_LENGTH
} from '$lib/server/security/argon2';

/** Unlock cookie name prefix (per note row; the note id completes the name). */
export const NOTE_UNLOCK_COOKIE_PREFIX = 'wl_note_';

/** Failed-attempt budget for the unlock form (counted only on failure). */
export const NOTE_GATE_RATE_LIMIT = { limit: 5, windowSeconds: 60 } as const;

export function noteUnlockCookieName(noteId: string): string {
	return `${NOTE_UNLOCK_COOKIE_PREFIX}${noteId}`;
}

/** PHC string for a note password (kept as a named wrapper for callers). */
export const hashNotePassword = hashArgon2id;

/** Constant-time password check against a stored PHC string. */
export const verifyNotePassword = verifyArgon2id;

const GATE_KEY_INFO = 'web-lair:notes-gate';

/**
 * The secret better-auth currently signs with (W2.11 / decision T4-B).
 *
 * `BETTER_AUTH_SECRETS` is the official keyring: `"<version>:<secret>,..."`,
 * newest first, and better-auth's `secretConfig.current` is the FIRST entry
 * (verified in 1.7.5 `secret-utils.mjs`). Reading the same entry keeps the
 * note-gate HMAC in step with the auth plane without adding a
 * `NOTE_GATE_SECRET` bootstrap key. A malformed keyring throws instead of
 * silently falling back to the legacy secret - a divergence here would sign
 * unlock tokens with a different key than every other replica.
 */
export function currentAuthSecret(getEnv: (name: string) => string | undefined): string {
	const raw = getEnv('BETTER_AUTH_SECRETS') ?? '';
	if (raw !== '') {
		// Validate EVERY entry with better-auth's rules (parseSecretsEnv): an
		// empty or malformed later entry makes better-auth throw, so note-gate
		// must not silently sign with the first value in that case.
		const entries = raw.split(',');
		let firstValue: string | null = null;
		const seen = new Set<number>();
		for (const [index, entry] of entries.entries()) {
			const trimmed = entry.trim();
			const colon = trimmed.indexOf(':');
			if (colon <= 0 || colon === trimmed.length - 1) {
				throw new Error(
					`[note-gate] BETTER_AUTH_SECRETS entry ${index + 1} must look like "<version>:<secret>"`
				);
			}
			const version = Number(trimmed.slice(0, colon).trim());
			const value = trimmed.slice(colon + 1).trim();
			if (!Number.isInteger(version) || version < 0 || !value) {
				throw new Error('[note-gate] BETTER_AUTH_SECRETS is malformed');
			}
			if (seen.has(version)) {
				throw new Error(`[note-gate] BETTER_AUTH_SECRETS lists version ${version} twice`);
			}
			seen.add(version);
			if (index === 0) firstValue = value;
		}
		// `entries` is non-empty whenever `raw !== ''`, so this is the current
		// (first) secret - the same one better-auth uses.
		return firstValue as string;
	}
	const secret = (getEnv('BETTER_AUTH_SECRET') ?? '').trim();
	if (!secret) {
		throw new Error('[note-gate] BETTER_AUTH_SECRET is not set; unlock tokens cannot be signed');
	}
	return secret;
}

/**
 * HKDF-derived signing key (RFC 5869; domain-separated from every other
 * consumer of the current auth secret). Rotating the auth keyring invalidates
 * all outstanding unlocks - acceptable inside the 30-day TTL and required by
 * W2.11: one current version, no second key to keep in sync.
 */
function gateSigningKey(): Buffer {
	const secret = currentAuthSecret((name) => env[name]);
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
