import { describe, expect, it, vi } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import {
	accountPasswordAlgorithm,
	hashAccountPassword,
	verifyAccountPassword
} from './password';

/**
 * W8.8 password-format tests: Argon2id is the default, the legacy better-auth
 * scrypt format still verifies, and the env switch only changes the write
 * format (never the read path).
 */
function legacyScryptHash(password: string): string {
	const salt = randomBytes(16);
	const key = scryptSync(password.normalize('NFKC'), salt, 64, {
		N: 16384,
		r: 16,
		p: 1,
		maxmem: 128 * 16384 * 16 * 2
	});
	return `${salt.toString('hex')}:${key.toString('hex')}`;
}

describe('account password hashing', () => {
	it('defaults to argon2id and honours PASSWORD_HASH_ALGO=scrypt', () => {
		expect(accountPasswordAlgorithm(() => undefined)).toBe('argon2id');
		expect(accountPasswordAlgorithm((name) => (name === 'PASSWORD_HASH_ALGO' ? 'scrypt' : ''))).toBe(
			'scrypt'
		);
		expect(accountPasswordAlgorithm((name) => (name === 'PASSWORD_HASH_ALGO' ? 'ARGON2ID' : ''))).toBe(
			'argon2id'
		);
	});

	it('writes an argon2id PHC string and verifies only the right password', async () => {
		const hash = await hashAccountPassword('correct horse battery staple', () => undefined);
		expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
		expect(
			await verifyAccountPassword({ hash, password: 'correct horse battery staple' })
		).toBe(true);
		expect(await verifyAccountPassword({ hash, password: 'wrong password' })).toBe(false);
	});

	it('verifies legacy scrypt hashes produced by better-auth', async () => {
		const hash = legacyScryptHash('legacy-password');
		expect(hash).not.toContain('$argon2id$');
		expect(await verifyAccountPassword({ hash, password: 'legacy-password' })).toBe(true);
		expect(await verifyAccountPassword({ hash, password: 'not-the-password' })).toBe(false);
	});

	it('rejects malformed and empty stored hashes without throwing', async () => {
		for (const hash of ['', 'not-a-hash', '$argon2id$v=19$m=1,t=1,p=1$abc$def', 'a:b']) {
			expect(await verifyAccountPassword({ hash, password: 'x' })).toBe(false);
		}
	});

	it('rolls writes back to scrypt when the env switch is scrypt', async () => {
		const hash = await hashAccountPassword('rollback-password', (name) =>
			name === 'PASSWORD_HASH_ALGO' ? 'scrypt' : ''
		);
		expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
		expect(await verifyAccountPassword({ hash, password: 'rollback-password' })).toBe(true);
	});
});
