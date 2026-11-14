import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, secretAad } from './crypto.ts';
import { KeyringConfigError, keyringFromEnv, parseKeyring } from './keyring.ts';
import { SecretError } from './errors.ts';

const K1 = Buffer.alloc(32, 0x11);
const K2 = Buffer.alloc(32, 0x22);
const B64_1 = K1.toString('base64');
const B64_2 = K2.toString('base64');
const HEX_1 = K1.toString('hex');
const AAD = secretAad('ai_provider_secrets', '33333333-3333-3333-3333-333333333333', 'ciphertext');

function env(entries: Record<string, string>) {
	return (name: string) => entries[name];
}

describe('SECRETS keyring', () => {
	it('accepts the legacy single SECRETS_KEY as version 1', () => {
		const ring = parseKeyring({ legacy: B64_1 });
		expect(ring.activeVersion).toBe(1);
		expect(ring.resolve(1)?.equals(K1)).toBe(true);
		expect(ring.resolve(2)).toBeNull();
	});

	it('accepts a hex key and a base64url key', () => {
		expect(parseKeyring({ legacy: HEX_1 }).resolve(1)?.equals(K1)).toBe(true);
		const urlSafe = K1.toString('base64url');
		expect(parseKeyring({ legacy: urlSafe }).resolve(1)?.equals(K1)).toBe(true);
	});

	it('honours SECRETS_KEY_ACTIVE rather than list order', () => {
		const ring = parseKeyring({ keys: `1:${B64_1},2:${B64_2}`, active: '2' });
		expect(ring.activeVersion).toBe(2);
		expect(ring.resolve(1)?.equals(K1)).toBe(true);
		expect(ring.resolve(2)?.equals(K2)).toBe(true);
	});

	it('runs the three-phase rotation: distribute, activate, retire', () => {
		// Phase 1: only v1 is known; new writes use v1.
		const phase1 = parseKeyring({ keys: `1:${B64_1}`, active: '1' });
		const oldEnvelope = encryptSecret('old-secret', phase1.resolve(1)!, phase1.activeVersion, AAD);

		// Phase 2: v2 distributed and activated. Old rows stay readable; new
		// writes use v2.
		const phase2 = parseKeyring({ keys: `2:${B64_2},1:${B64_1}`, active: '2' });
		expect(decryptSecret(oldEnvelope, phase2.resolve, AAD).plaintext).toBe('old-secret');
		const newEnvelope = encryptSecret('new-secret', phase2.resolve(2)!, phase2.activeVersion, AAD);
		expect(newEnvelope.startsWith('v1:2:')).toBe(true);
		expect(decryptSecret(newEnvelope, phase2.resolve, AAD).plaintext).toBe('new-secret');

		// Phase 3: v1 retired. Old ciphertext fails closed with a typed code;
		// it does not fall back to v2.
		const phase3 = parseKeyring({ keys: `2:${B64_2}`, active: '2' });
		try {
			decryptSecret(oldEnvelope, phase3.resolve, AAD);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect(caught).toBeInstanceOf(SecretError);
			expect((caught as SecretError).code).toBe('unknown_key_version');
		}
		expect(decryptSecret(newEnvelope, phase3.resolve, AAD).plaintext).toBe('new-secret');
	});

	it('is not configured when neither variable is set', () => {
		expect(() => keyringFromEnv(env({}))).toThrowError(KeyringConfigError);
		try {
			keyringFromEnv(env({}));
		} catch (caught) {
			expect((caught as KeyringConfigError).reason).toBe('not_configured');
		}
	});

	it('reads SECRETS_KEYS / SECRETS_KEY_ACTIVE / SECRETS_KEY from the env lookup', () => {
		const ring = keyringFromEnv(
			env({ SECRETS_KEYS: `2:${B64_2},1:${B64_1}`, SECRETS_KEY_ACTIVE: '2' })
		);
		expect(ring.activeVersion).toBe(2);
		expect(keyringFromEnv(env({ SECRETS_KEY: B64_1 })).activeVersion).toBe(1);
	});

	it('rejects a key map without ACTIVE or with an ACTIVE that is not listed', () => {
		expect(() => parseKeyring({ keys: `1:${B64_1}` })).toThrowError(/SECRETS_KEY_ACTIVE/);
		expect(() => parseKeyring({ keys: `1:${B64_1}`, active: '2' })).toThrowError(
			/not present in SECRETS_KEYS/
		);
	});

	it('merges the legacy SECRETS_KEY as version 1 when the map omits it', () => {
		const ring = parseKeyring({ keys: `2:${B64_2}`, active: '2', legacy: B64_1 });
		expect(ring.activeVersion).toBe(2);
		expect(ring.resolve(1)?.equals(K1)).toBe(true);
		expect(ring.resolve(2)?.equals(K2)).toBe(true);
	});

	it('rejects a legacy SECRETS_KEY that conflicts with explicit version 1', () => {
		expect(() => parseKeyring({ keys: `1:${B64_2}`, active: '1', legacy: B64_1 })).toThrow(
			/conflicts with SECRETS_KEYS version 1/
		);
		// Identical values are not a conflict.
		expect(
			parseKeyring({ keys: `1:${B64_1}`, active: '1', legacy: B64_1 })
				.resolve(1)
				?.equals(K1)
		).toBe(true);
	});

	it('rejects duplicate versions, short keys and malformed entries', () => {
		const cases: Array<Record<string, string>> = [
			{ keys: `1:${B64_1},1:${B64_2}`, active: '1' },
			{ keys: `1:${Buffer.alloc(16).toString('base64')}`, active: '1' },
			{ keys: `0:${B64_1}`, active: '0' },
			{ keys: `x:${B64_1}`, active: '1' },
			{ keys: B64_1, active: '1' },
			{ keys: `1:`, active: '1' },
			{ keys: `1:not-a-key`, active: '1' },
			{ active: '2', legacy: B64_1 }
		];
		for (const input of cases) {
			expect(() => parseKeyring(input)).toThrowError(KeyringConfigError);
		}
	});

	it('never echoes key material in an error message', () => {
		try {
			parseKeyring({ keys: `1:${Buffer.alloc(16).toString('base64')}`, active: '1' });
			throw new Error('expected a KeyringConfigError');
		} catch (caught) {
			const message = (caught as Error).message;
			expect(message).not.toContain(Buffer.alloc(16).toString('base64'));
			expect(message).toMatch(/32 bytes/);
		}
	});
});
