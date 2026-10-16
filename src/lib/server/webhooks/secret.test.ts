import { describe, expect, it } from 'vitest';
import { generateWebhookSecret, maskWebhookSecret } from './secret';

describe('generateWebhookSecret', () => {
	it('emits whsec_ + base64 of 32 bytes', () => {
		const secret = generateWebhookSecret();
		expect(secret.startsWith('whsec_')).toBe(true);
		const raw = Buffer.from(secret.slice('whsec_'.length), 'base64');
		expect(raw).toHaveLength(32);
	});

	it('never repeats (each endpoint gets its own secret)', () => {
		const a = generateWebhookSecret();
		const b = generateWebhookSecret();
		expect(a).not.toBe(b);
	});
});

describe('maskWebhookSecret', () => {
	it('keeps the prefix + last four, hides the body', () => {
		const secret = generateWebhookSecret();
		const masked = maskWebhookSecret(secret);
		expect(masked.startsWith('whsec_')).toBe(true);
		expect(masked.endsWith(secret.slice(-4))).toBe(true);
		expect(masked).not.toContain(secret.slice(8, 20));
		expect(masked.length).toBeLessThan(secret.length);
	});
});
