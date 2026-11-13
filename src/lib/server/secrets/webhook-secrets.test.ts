import { describe, expect, it } from 'vitest';
import { webhookSecrets } from '../db/system/webhook-secret.schema.ts';
import { SecretError } from './errors.ts';
import { parseKeyring } from './keyring.ts';
import type { SecretDb } from './resolver.ts';
import {
	encryptPreviousWebhookSecret,
	encryptWebhookSecretValue,
	readWebhookSecretStatuses,
	resolveWebhookSigningSecrets,
	WEBHOOK_SECRET_GRACE_MS
} from './webhook-secrets.ts';

const KEY = Buffer.alloc(32, 0x44);
const RING = parseKeyring({ keys: `1:${KEY.toString('base64')}`, active: '1' });
const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NOW = new Date('2026-11-13T12:00:00Z');
const deps = { getEnv: () => undefined, keyring: RING };

function dbWith(options: { secretRow?: unknown; legacy?: string | null }) {
	return {
		select: () => ({
			from: (table: unknown) => ({
				where: () => ({
					limit: async () =>
						table === webhookSecrets
							? options.secretRow
								? [options.secretRow]
								: []
							: options.legacy
								? [{ secret: options.legacy }]
								: []
				})
			})
		})
	} as unknown as SecretDb;
}

function row(
	overrides: Partial<{
		ciphertext: string;
		keyVersion: number;
		previousCiphertext: string | null;
		previousKeyVersion: number | null;
		previousExpiresAt: Date | null;
	}> = {}
) {
	const current = encryptWebhookSecretValue(ID, 'whsec_current', RING);
	return {
		ciphertext: current.ciphertext,
		keyVersion: current.keyVersion,
		previousCiphertext: null,
		previousKeyVersion: null,
		previousExpiresAt: null,
		...overrides
	};
}

describe('resolveWebhookSigningSecrets', () => {
	it('returns the encrypted current secret', async () => {
		const resolved = await resolveWebhookSigningSecrets(
			dbWith({ secretRow: row() }),
			ID,
			deps,
			NOW
		);
		expect(resolved).toMatchObject({ current: 'whsec_current', source: 'db', previous: null });
	});

	it('returns the previous secret while the grace window is open', async () => {
		const previous = encryptPreviousWebhookSecret(ID, 'whsec_previous', RING);
		const resolved = await resolveWebhookSigningSecrets(
			dbWith({
				secretRow: row({
					previousCiphertext: previous.ciphertext,
					previousKeyVersion: previous.keyVersion,
					previousExpiresAt: new Date(NOW.getTime() + WEBHOOK_SECRET_GRACE_MS)
				})
			}),
			ID,
			deps,
			NOW
		);
		expect(resolved.current).toBe('whsec_current');
		expect(resolved.previous).toBe('whsec_previous');
	});

	it('drops an expired previous secret', async () => {
		const previous = encryptPreviousWebhookSecret(ID, 'whsec_previous', RING);
		const resolved = await resolveWebhookSigningSecrets(
			dbWith({
				secretRow: row({
					previousCiphertext: previous.ciphertext,
					previousKeyVersion: previous.keyVersion,
					previousExpiresAt: new Date(NOW.getTime() - 1)
				})
			}),
			ID,
			deps,
			NOW
		);
		expect(resolved.previous).toBeNull();
	});

	it('falls back to the legacy plaintext column for an un-migrated endpoint', async () => {
		const resolved = await resolveWebhookSigningSecrets(
			dbWith({ legacy: 'whsec_legacy' }),
			ID,
			deps,
			NOW
		);
		expect(resolved).toMatchObject({ current: 'whsec_legacy', source: 'legacy' });
	});

	it('reports missing when neither store has a value', async () => {
		try {
			await resolveWebhookSigningSecrets(dbWith({}), ID, deps, NOW);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect((caught as SecretError).code).toBe('missing');
		}
	});

	it('fails closed on a tampered ciphertext', async () => {
		const broken = { ...row(), ciphertext: 'v1:1:AAAA:BBBB:CCCC' };
		try {
			await resolveWebhookSigningSecrets(dbWith({ secretRow: broken }), ID, deps, NOW);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect((caught as SecretError).code).toBe('decrypt_failed');
		}
	});

	it('drops a previous ciphertext that cannot be opened instead of failing the delivery', async () => {
		const foreign = encryptPreviousWebhookSecret(OTHER, 'whsec_previous', RING);
		const resolved = await resolveWebhookSigningSecrets(
			dbWith({
				secretRow: row({
					previousCiphertext: foreign.ciphertext,
					previousKeyVersion: foreign.keyVersion,
					previousExpiresAt: new Date(NOW.getTime() + 1000)
				})
			}),
			ID,
			deps,
			NOW
		);
		// The current slot is healthy; a moved/corrupt grace value is dropped
		// so the endpoint keeps delivering with one signature.
		expect(resolved.current).toBe('whsec_current');
		expect(resolved.previous).toBeNull();
		expect(resolved.previousExpiresAt).toBeNull();
	});

	it('reports an unavailable store instead of treating it as missing', async () => {
		const failing = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => {
							throw new Error('relation does not exist');
						}
					})
				})
			})
		} as unknown as SecretDb;
		try {
			await resolveWebhookSigningSecrets(failing, ID, deps, NOW);
			throw new Error('expected a SecretError');
		} catch (caught) {
			expect((caught as SecretError).code).toBe('store_unavailable');
		}
	});
});

describe('readWebhookSecretStatuses', () => {
	it('returns status and hint only', async () => {
		const current = encryptWebhookSecretValue(ID, 'whsec_current', RING);
		const db = {
			select: () => ({
				from: () => ({
					where: async () => [
						{
							webhookId: ID,
							hint: current.hint,
							updatedAt: NOW,
							previousExpiresAt: null
						}
					]
				})
			})
		} as unknown as SecretDb;
		const statuses = await readWebhookSecretStatuses(db, [ID]);
		expect(statuses.get(ID)).toEqual({
			configured: true,
			hint: current.hint,
			updatedAt: NOW,
			previousExpiresAt: null
		});
		expect(JSON.stringify([...statuses.values()])).not.toContain('v1:');
	});

	it('degrades to an empty map when the store fails', async () => {
		const failing = {
			select: () => ({
				from: () => ({
					where: async () => {
						throw new Error('nope');
					}
				})
			})
		} as unknown as SecretDb;
		expect((await readWebhookSecretStatuses(failing, [ID])).size).toBe(0);
	});
});
