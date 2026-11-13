import { describe, expect, it } from 'vitest';
import {
	CIPHERTEXT_FORMAT_VERSION,
	ciphertextKeyVersion,
	decryptSecret,
	encryptSecret,
	secretAad
} from './crypto.ts';
import { SecretError } from './errors.ts';

const KEY_V1 = Buffer.alloc(32, 1);
const KEY_V2 = Buffer.alloc(32, 2);
const AAD = secretAad('ai_provider_secrets', '11111111-1111-1111-1111-111111111111', 'ciphertext');

function keyring(keys: Record<number, Buffer>) {
	return (version: number) => keys[version] ?? null;
}

/** NIST SP 800-38D / McGrew-Viega GCM spec, AES-256 test case 13. */
const NIST_KEY = Buffer.alloc(32, 0);
const NIST_IV = Buffer.alloc(12, 0);
const NIST_PLAINTEXT = Buffer.alloc(16, 0);
const NIST_CIPHERTEXT = Buffer.from('cea7403d4d606b6e074ec5d3baf39d18', 'hex');
const NIST_TAG = Buffer.from('d0d1c8a799996bf0265b98b5d48ab919', 'hex');

describe('AES-256-GCM envelope', () => {
	it('matches the published AES-256-GCM test vector (case 13)', () => {
		const envelope = [
			CIPHERTEXT_FORMAT_VERSION,
			'1',
			NIST_IV.toString('base64url'),
			NIST_TAG.toString('base64url'),
			NIST_CIPHERTEXT.toString('base64url')
		].join(':');
		const decrypted = decryptSecret(envelope, keyring({ 1: NIST_KEY }), '');
		expect(decrypted.keyVersion).toBe(1);
		expect(Buffer.from(decrypted.plaintext, 'utf8').equals(NIST_PLAINTEXT)).toBe(true);
	});

	it('round-trips UTF-8 plaintext and reports the key version', () => {
		const value = 'sk-proj-密钥-🔑-AbCd';
		const envelope = encryptSecret(value, KEY_V2, 2, AAD);
		expect(envelope.startsWith('v1:2:')).toBe(true);
		expect(ciphertextKeyVersion(envelope)).toBe(2);
		expect(decryptSecret(envelope, keyring({ 2: KEY_V2 }), AAD)).toEqual({
			plaintext: value,
			keyVersion: 2
		});
	});

	it('uses a fresh IV for every write (same plaintext, different envelope)', () => {
		const a = encryptSecret('same-secret', KEY_V1, 1, AAD);
		const b = encryptSecret('same-secret', KEY_V1, 1, AAD);
		expect(a).not.toBe(b);
		expect(decryptSecret(a, keyring({ 1: KEY_V1 }), AAD).plaintext).toBe('same-secret');
		expect(decryptSecret(b, keyring({ 1: KEY_V1 }), AAD).plaintext).toBe('same-secret');
	});

	it('rejects a tampered ciphertext, tag or IV', () => {
		const envelope = encryptSecret('rotate-me', KEY_V1, 1, AAD);
		const parts = envelope.split(':');
		const flip = (part: string): string => {
			const raw = Buffer.from(part, 'base64url');
			raw[0] ^= 0x01;
			return raw.toString('base64url');
		};
		for (const index of [2, 3, 4]) {
			const tampered = [...parts];
			tampered[index] = flip(parts[index]);
			expect(() => decryptSecret(tampered.join(':'), keyring({ 1: KEY_V1 }), AAD)).toThrowError(
				SecretError
			);
		}
	});

	it('rejects a ciphertext moved to another row (AAD binding)', () => {
		const envelope = encryptSecret('row-bound', KEY_V1, 1, AAD);
		const otherAad = secretAad(
			'ai_provider_secrets',
			'22222222-2222-2222-2222-222222222222',
			'ciphertext'
		);
		expect(() => decryptSecret(envelope, keyring({ 1: KEY_V1 }), otherAad)).toThrowError(
			/authentication/
		);
	});

	it('rejects the wrong key and reports a missing key version separately', () => {
		const envelope = encryptSecret('wrong-key', KEY_V1, 1, AAD);
		expect(() => decryptSecret(envelope, keyring({ 1: KEY_V2 }), AAD)).toThrowError(
			/authentication/
		);
		try {
			decryptSecret(envelope, keyring({ 2: KEY_V2 }), AAD);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect(caught).toBeInstanceOf(SecretError);
			expect((caught as SecretError).code).toBe('unknown_key_version');
		}
	});

	it('encrypts old rows with the old version and new rows with the active one', () => {
		const oldEnvelope = encryptSecret('old', KEY_V1, 1, AAD);
		const newEnvelope = encryptSecret('new', KEY_V2, 2, AAD);
		const ring = keyring({ 1: KEY_V1, 2: KEY_V2 });
		expect(decryptSecret(oldEnvelope, ring, AAD).plaintext).toBe('old');
		expect(decryptSecret(newEnvelope, ring, AAD).plaintext).toBe('new');
		expect(ciphertextKeyVersion(oldEnvelope)).toBe(1);
		expect(ciphertextKeyVersion(newEnvelope)).toBe(2);
	});

	it('rejects malformed envelopes without leaking OpenSSL details', () => {
		const cases = [
			'',
			'plaintext-secret',
			'v2:1:aaaa:bbbb:cccc',
			'v1:0:aaaa:bbbb:cccc',
			'v1:one:aaaa:bbbb:cccc',
			'v1:1:!!!!:bbbb:cccc',
			'v1:1:aaaa:bbbb',
			'v1:1:aaaa:bbbb:cccc:dddd'
		];
		for (const value of cases) {
			try {
				decryptSecret(value, keyring({ 1: KEY_V1 }), AAD);
				throw new Error(`expected a SecretError for ${JSON.stringify(value)}`);
			} catch (caught) {
				expect(caught).toBeInstanceOf(SecretError);
				expect((caught as SecretError).code).toBe('decrypt_failed');
			}
		}
	});

	it('refuses an empty secret and invalid key material at write time', () => {
		expect(() => encryptSecret('', KEY_V1, 1, AAD)).toThrow(/empty secret/);
		expect(() => encryptSecret('x', Buffer.alloc(16), 1, AAD)).toThrow(/32 bytes/);
		expect(() => encryptSecret('x', KEY_V1, 0, AAD)).toThrow(/positive integer/);
	});

	it('reports a non-canonical base64url part as a format failure', () => {
		const envelope = encryptSecret('canonical', KEY_V1, 1, AAD);
		const parts = envelope.split(':');
		// 'AB' and 'AA' decode to the same byte (the last 4 bits are padding
		// bits); Node accepts both, the strict decoder must reject the
		// non-canonical spelling so one value has exactly one wire form.
		parts[4] = 'AB';
		expect(() => decryptSecret(parts.join(':'), keyring({ 1: KEY_V1 }), AAD)).toThrowError(
			/non-canonical/
		);
	});
});
