import { describe, expect, it } from 'vitest';
import { sanitizeProviderError } from './provider-status';

describe('sanitizeProviderError', () => {
	it('drops full URLs (including signed query strings)', () => {
		expect(sanitizeProviderError('GET https://api.example.com/v1?key=abc failed')).toBe(
			'GET [url] failed'
		);
	});

	it('redacts authorization headers and key/token pairs', () => {
		expect(sanitizeProviderError('Authorization: Bearer sk-live-123')).toBe(
			'authorization=[redacted]'
		);
		expect(sanitizeProviderError('token=abc secret: xyz')).toBe(
			'token=[redacted] secret=[redacted]'
		);
		expect(sanitizeProviderError('password = hunter2')).toBe('password=[redacted]');
	});

	it('caps the message and normalizes whitespace', () => {
		const out = sanitizeProviderError(new Error(`a\n\n${'x'.repeat(400)}`), 40);
		expect(out).toHaveLength(41); // 40 chars + the ellipsis
		expect(out.endsWith('…')).toBe(true);
		expect(out).not.toContain('\n');
	});

	it('handles a non-Error value without leaking an object dump', () => {
		expect(sanitizeProviderError({ key: 'abc' })).toBe('[object Object]');
		expect(sanitizeProviderError('')).toBe('Unknown error');
	});
});
