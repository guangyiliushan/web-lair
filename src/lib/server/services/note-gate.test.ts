import { beforeAll, describe, expect, it, vi } from 'vitest';
import { argon2 } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password-gate crypto tests: argon2id hashing/verification (the
 * OWASP minimum profile, PHC storage, weak-parameter rejection, the PHC
 * `p` parameter being read and used) and the unlock-token lifecycle
 * (sign/verify, expiry, tampering, note-id binding, password-change
 * revocation, missing-secret fail-closed).
 */
vi.mock('$env/dynamic/private', () => ({ env: { BETTER_AUTH_SECRET: 'unit-test-secret' } }));
const { gateState } = vi.hoisted(() => ({ gateState: { ttlDays: 30 } }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async (key: string) =>
		key === 'notes.gate' ? { ttlDays: gateState.ttlDays } : null
	)
}));

import {
	currentAuthSecret,
	hashNotePassword,
	noteGateTtlSeconds,
	noteUnlockCookieName,
	signNoteUnlockToken,
	verifyNotePassword,
	verifyNoteUnlockToken,
	NOTE_GATE_RATE_LIMIT,
	NOTE_UNLOCK_COOKIE_PREFIX
} from './note-gate';

const NOTE_ID = '11111111-1111-1111-1111-111111111111';

describe('note-gate password hashing', () => {
	it('round-trips a correct password through the PHC string', async () => {
		const phc = await hashNotePassword('correct horse battery staple');
		expect(phc.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
		expect(await verifyNotePassword('correct horse battery staple', phc)).toBe(true);
	});

	it('rejects a wrong password', async () => {
		const phc = await hashNotePassword('right-password');
		expect(await verifyNotePassword('wrong-password', phc)).toBe(false);
	});

	it('rejects an empty password input', async () => {
		const phc = await hashNotePassword('real-password');
		expect(await verifyNotePassword('', phc)).toBe(false);
	});

	it('rejects a weak-parameter PHC string (cost floor)', async () => {
		// m=8 below the minimum: a row from outside the write path must not
		// get a cheap verification pass.
		const weak =
			'$argon2id$v=19$m=8,t=1,p=1$' +
			Buffer.alloc(16, 1).toString('base64') +
			'$' +
			Buffer.alloc(32, 2).toString('base64');
		expect(await verifyNotePassword('anything', weak)).toBe(false);
	});

	it('rejects malformed PHC strings', async () => {
		expect(await verifyNotePassword('x', 'not-a-phc')).toBe(false);
		expect(await verifyNotePassword('x', '$argon2i$v=19$m=19456,t=2,p=1$abc$def')).toBe(false);
		expect(await verifyNotePassword('x', '$argon2id$v=19$m=19456,t=2,p=1$!notb64!$!notb64!')).toBe(
			false
		);
		// Missing `p` is rejected outright (it is part of what we emit).
		expect(
			await verifyNotePassword(
				'x',
				'$argon2id$v=19$m=19456,t=2$' +
					Buffer.alloc(16, 1).toString('base64') +
					'$' +
					Buffer.alloc(32, 2).toString('base64')
			)
		).toBe(false);
	});

	it('verifies against the PHC `p` parameter, not a constant', async () => {
		// A row hashed with parallelism 2 must keep verifying (a future
		// constant bump must not silently orphan existing rows).
		const salt = Buffer.alloc(16, 9);
		const tag = await promisify(argon2)('argon2id', {
			message: Buffer.from('parallel-pass', 'utf8'),
			nonce: salt,
			tagLength: 32,
			memory: 19456,
			passes: 2,
			parallelism: 2
		});
		const phc = `$argon2id$v=19$m=19456,t=2,p=2$${salt.toString('base64')}$${tag.toString('base64')}`;
		expect(await verifyNotePassword('parallel-pass', phc)).toBe(true);
		expect(await verifyNotePassword('wrong', phc)).toBe(false);
	});

	it('produces distinct salts per call', async () => {
		const a = await hashNotePassword('same');
		const b = await hashNotePassword('same');
		expect(a).not.toBe(b);
		// Same password, different salts: both verify.
		expect(await verifyNotePassword('same', a)).toBe(true);
		expect(await verifyNotePassword('same', b)).toBe(true);
	});
});

describe('note-gate unlock tokens', () => {
	let EXP: number;
	let phc: string;

	beforeAll(async () => {
		EXP = Math.floor(Date.now() / 1000) + 3600;
		phc = await hashNotePassword('diary-pass');
	});

	it('signs and verifies a token for the matching row and hash', () => {
		const token = signNoteUnlockToken(NOTE_ID, phc, EXP);
		expect(verifyNoteUnlockToken(NOTE_ID, phc, token, new Date())).toBe(true);
	});

	it('rejects an expired token', () => {
		const token = signNoteUnlockToken(NOTE_ID, phc, EXP);
		const later = new Date((EXP + 3600) * 1000);
		expect(verifyNoteUnlockToken(NOTE_ID, phc, token, later)).toBe(false);
	});

	it('rejects a tampered signature', () => {
		const token = signNoteUnlockToken(NOTE_ID, phc, EXP);
		const [exp, sig] = token.split('.');
		const flipped = sig.endsWith('A') ? sig.slice(0, -1) + 'B' : sig.slice(0, -1) + 'A';
		expect(verifyNoteUnlockToken(NOTE_ID, phc, `${exp}.${flipped}`, new Date())).toBe(false);
	});

	it('rejects a token signed for a different note id', () => {
		const token = signNoteUnlockToken(NOTE_ID, phc, EXP);
		expect(
			verifyNoteUnlockToken('22222222-2222-2222-2222-222222222222', phc, token, new Date())
		).toBe(false);
	});

	it('revokes outstanding tokens when the password hash changes', async () => {
		const token = signNoteUnlockToken(NOTE_ID, phc, EXP);
		const newPhc = await hashNotePassword('new-diary-pass');
		expect(verifyNoteUnlockToken(NOTE_ID, newPhc, token, new Date())).toBe(false);
	});

	it('rejects malformed token strings', () => {
		expect(verifyNoteUnlockToken(NOTE_ID, phc, '', new Date())).toBe(false);
		expect(verifyNoteUnlockToken(NOTE_ID, phc, 'nonsense', new Date())).toBe(false);
		expect(verifyNoteUnlockToken(NOTE_ID, phc, '.sig', new Date())).toBe(false);
		expect(verifyNoteUnlockToken(NOTE_ID, phc, '123.sig', new Date())).toBe(false);
	});

	it('fails closed when the signing secret is missing (throws, never signs)', async () => {
		const envModule = (await import('$env/dynamic/private')) as {
			env: Record<string, string | undefined>;
		};
		const original = envModule.env.BETTER_AUTH_SECRET;
		envModule.env.BETTER_AUTH_SECRET = '';
		try {
			expect(() => signNoteUnlockToken(NOTE_ID, phc, EXP)).toThrow(/BETTER_AUTH_SECRET/);
			// Verification also refuses to run without a key: a token that
			// passes the expiry check must still throw before any HMAC compare.
			expect(() => verifyNoteUnlockToken(NOTE_ID, phc, `${EXP}.fake`, new Date())).toThrow(
				/BETTER_AUTH_SECRET/
			);
		} finally {
			envModule.env.BETTER_AUTH_SECRET = original;
		}
	});
});

describe('note-gate configuration', () => {
	it('derives the cookie TTL from the notes.gate option', async () => {
		expect(await noteGateTtlSeconds()).toBe(30 * 86400);
	});

	it('follows a changed TTL instead of pinning the default (W6.6)', async () => {
		gateState.ttlDays = 7;
		try {
			expect(await noteGateTtlSeconds()).toBe(7 * 86400);
		} finally {
			gateState.ttlDays = 30;
		}
	});

	it('names the cookie per note row', () => {
		expect(noteUnlockCookieName(NOTE_ID)).toBe(`${NOTE_UNLOCK_COOKIE_PREFIX}${NOTE_ID}`);
	});

	it('ships the fixed failure-budget constants', () => {
		expect(NOTE_GATE_RATE_LIMIT).toEqual({ limit: 5, windowSeconds: 60 });
	});
});

describe('note-gate auth secret selection (W2.11 / T4-B)', () => {
	const getEnv = (values: Record<string, string>) => (name: string) => values[name];

	it('falls back to BETTER_AUTH_SECRET when no keyring is set', () => {
		expect(currentAuthSecret(getEnv({ BETTER_AUTH_SECRET: 'legacy-secret' }))).toBe(
			'legacy-secret'
		);
	});

	it('reads the FIRST keyring entry, which is what better-auth signs with', () => {
		expect(
			currentAuthSecret(
				getEnv({ BETTER_AUTH_SECRETS: '2:newer-secret,1:older-secret', BETTER_AUTH_SECRET: 'x' })
			)
		).toBe('newer-secret');
		// Order is the source of truth, not the numeric order.
		expect(currentAuthSecret(getEnv({ BETTER_AUTH_SECRETS: '7:seven,2:two' }))).toBe('seven');
	});

	it('fails closed on a malformed keyring instead of using the legacy secret', () => {
		expect(() => currentAuthSecret(getEnv({ BETTER_AUTH_SECRETS: 'missing-version' }))).toThrow(
			/BETTER_AUTH_SECRETS/
		);
		expect(() => currentAuthSecret(getEnv({ BETTER_AUTH_SECRETS: '2:' }))).toThrow(
			/BETTER_AUTH_SECRETS/
		);
		expect(() =>
			currentAuthSecret(getEnv({ BETTER_AUTH_SECRETS: 'x:secret', BETTER_AUTH_SECRET: 'legacy' }))
		).toThrow(/BETTER_AUTH_SECRETS/);
		// A defect in a LATER entry makes better-auth throw; note-gate must not
		// sign with the first value in that case.
		expect(() =>
			currentAuthSecret(getEnv({ BETTER_AUTH_SECRETS: '2:new,1:', BETTER_AUTH_SECRET: 'legacy' }))
		).toThrow(/BETTER_AUTH_SECRETS/);
		expect(() =>
			currentAuthSecret(getEnv({ BETTER_AUTH_SECRETS: '2:new, ', BETTER_AUTH_SECRET: 'legacy' }))
		).toThrow(/BETTER_AUTH_SECRETS/);
		expect(() => currentAuthSecret(getEnv({ BETTER_AUTH_SECRETS: '2:new,2:again' }))).toThrow(
			/twice/
		);
		// A whitespace-only value is NOT "unset" for better-auth: it tries to
		// parse an entry and throws.
		expect(() => currentAuthSecret(getEnv({ BETTER_AUTH_SECRETS: '   ' }))).toThrow(
			/BETTER_AUTH_SECRETS/
		);
	});

	it('invalidates outstanding unlock tokens when the current version rotates', async () => {
		const phc = await hashNotePassword('rotation-pass');
		const exp = Math.floor(Date.now() / 1000) + 3600;
		const envModule = (await import('$env/dynamic/private')) as {
			env: Record<string, string | undefined>;
		};
		const previous = envModule.env.BETTER_AUTH_SECRETS;
		try {
			envModule.env.BETTER_AUTH_SECRETS = '2:second-secret';
			const token = signNoteUnlockToken(NOTE_ID, phc, exp);
			expect(verifyNoteUnlockToken(NOTE_ID, phc, token, new Date())).toBe(true);

			// Same key still listed, but no longer current: verification uses
			// the current version only (one current key, no second secret).
			envModule.env.BETTER_AUTH_SECRETS = '3:third-secret,2:second-secret';
			expect(verifyNoteUnlockToken(NOTE_ID, phc, token, new Date())).toBe(false);
			// A token signed under the new current version verifies.
			const fresh = signNoteUnlockToken(NOTE_ID, phc, exp);
			expect(verifyNoteUnlockToken(NOTE_ID, phc, fresh, new Date())).toBe(true);
		} finally {
			envModule.env.BETTER_AUTH_SECRETS = previous;
		}
	});
});
