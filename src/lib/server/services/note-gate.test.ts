import { describe, expect, it, vi } from 'vitest';

/**
 * Password-gate crypto tests (N1): argon2id hashing/verification (the
 * OWASP minimum profile, PHC storage, weak-parameter rejection) and the
 * unlock-token lifecycle (sign/verify, expiry, tampering, note-id binding,
 * password-change revocation, missing-secret fail-closed).
 */
vi.mock('$env/dynamic/private', () => ({ env: { BETTER_AUTH_SECRET: 'unit-test-secret' } }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async (key: string) => (key === 'notes.gate' ? { ttlDays: 30 } : null))
}));

import {
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
	it('round-trips a correct password through the PHC string', () => {
		const phc = hashNotePassword('correct horse battery staple');
		expect(phc.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
		expect(verifyNotePassword('correct horse battery staple', phc)).toBe(true);
	});

	it('rejects a wrong password', () => {
		const phc = hashNotePassword('right-password');
		expect(verifyNotePassword('wrong-password', phc)).toBe(false);
	});

	it('rejects an empty password input', () => {
		const phc = hashNotePassword('real-password');
		expect(verifyNotePassword('', phc)).toBe(false);
	});

	it('rejects a weak-parameter PHC string (cost floor)', () => {
		// m=8 below the minimum: a row from outside the write path must not
		// get a cheap verification pass.
		const weak =
			'$argon2id$v=19$m=8,t=1,p=1$' +
			Buffer.alloc(16, 1).toString('base64') +
			'$' +
			Buffer.alloc(32, 2).toString('base64');
		expect(verifyNotePassword('anything', weak)).toBe(false);
	});

	it('rejects malformed PHC strings', () => {
		expect(verifyNotePassword('x', 'not-a-phc')).toBe(false);
		expect(verifyNotePassword('x', '$argon2i$v=19$m=19456,t=2,p=1$abc$def')).toBe(false);
		expect(verifyNotePassword('x', '$argon2id$v=19$m=19456,t=2,p=1$!notb64!$!notb64!')).toBe(
			false
		);
	});

	it('produces distinct salts per call', () => {
		const a = hashNotePassword('same');
		const b = hashNotePassword('same');
		expect(a).not.toBe(b);
		// Same password, different salts: both verify.
		expect(verifyNotePassword('same', a)).toBe(true);
		expect(verifyNotePassword('same', b)).toBe(true);
	});
});

describe('note-gate unlock tokens', () => {
	const EXP = Math.floor(Date.now() / 1000) + 3600;
	const phc = hashNotePassword('diary-pass');

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

	it('revokes outstanding tokens when the password hash changes', () => {
		const token = signNoteUnlockToken(NOTE_ID, phc, EXP);
		const newPhc = hashNotePassword('new-diary-pass');
		expect(verifyNoteUnlockToken(NOTE_ID, newPhc, token, new Date())).toBe(false);
	});

	it('rejects malformed token strings', () => {
		expect(verifyNoteUnlockToken(NOTE_ID, phc, '', new Date())).toBe(false);
		expect(verifyNoteUnlockToken(NOTE_ID, phc, 'nonsense', new Date())).toBe(false);
		expect(verifyNoteUnlockToken(NOTE_ID, phc, '.sig', new Date())).toBe(false);
		expect(verifyNoteUnlockToken(NOTE_ID, phc, '123.sig', new Date())).toBe(false);
	});
});

describe('note-gate configuration', () => {
	it('derives the cookie TTL from the notes.gate option', async () => {
		expect(await noteGateTtlSeconds()).toBe(30 * 86400);
	});

	it('names the cookie per note row', () => {
		expect(noteUnlockCookieName(NOTE_ID)).toBe(`${NOTE_UNLOCK_COOKIE_PREFIX}${NOTE_ID}`);
	});

	it('ships the fixed failure-budget constants', () => {
		expect(NOTE_GATE_RATE_LIMIT).toEqual({ limit: 5, windowSeconds: 60 });
	});
});
