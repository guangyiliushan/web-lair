import { describe, expect, it } from 'vitest';
import {
	NOTIFICATION_BODY_MAX,
	NOTIFICATION_TITLE_MAX,
	buildNotificationPayload,
	readNotificationPayload,
	redactNotificationError,
	sanitizeNotificationText,
	sanitizeNotificationUrl
} from './format';

/**
 * Payload shaping teeth (M6 P5, T5.4 "payload ≤200 字、无 PII"): the cap is a
 * promise the adapters rely on, and an address inside a comment excerpt must
 * not reach a phone push or the delivery table.
 */
describe('sanitizeNotificationText', () => {
	it('collapses newlines/tabs and control characters into one line', () => {
		expect(sanitizeNotificationText('a\n\nb\tc\u0000d', 100)).toBe('a b c d');
	});

	it('redacts email addresses', () => {
		expect(sanitizeNotificationText('mail me at alice@example.com please', 100)).toBe(
			'mail me at [address] please'
		);
	});

	it('caps at the limit and marks the cut with an ellipsis', () => {
		const out = sanitizeNotificationText('x'.repeat(500), NOTIFICATION_BODY_MAX);
		expect(out).toHaveLength(NOTIFICATION_BODY_MAX);
		expect(out.endsWith('…')).toBe(true);
	});

	it('keeps short text untouched', () => {
		expect(sanitizeNotificationText('  hello  ', 20)).toBe('hello');
	});
});

describe('sanitizeNotificationUrl', () => {
	it('keeps an https link but drops credentials, query and fragment', () => {
		expect(sanitizeNotificationUrl('https://lair.example/admin/comments?token=x#top')).toBe(
			'https://lair.example/admin/comments'
		);
	});

	it('refuses credentials, non-http schemes and junk', () => {
		expect(sanitizeNotificationUrl('https://user:pass@lair.example/a')).toBeUndefined();
		expect(sanitizeNotificationUrl('javascript:alert(1)')).toBeUndefined();
		expect(sanitizeNotificationUrl('not a url')).toBeUndefined();
		expect(sanitizeNotificationUrl(null)).toBeUndefined();
	});
});

describe('buildNotificationPayload / readNotificationPayload', () => {
	it('bounds both fields and keeps a safe link', () => {
		const payload = buildNotificationPayload({
			title: 't'.repeat(400),
			body: `${'b'.repeat(400)} bob@example.com`,
			url: 'https://lair.example/admin/jobs'
		});
		expect(String(payload.title)).toHaveLength(NOTIFICATION_TITLE_MAX);
		expect(String(payload.body)).toHaveLength(NOTIFICATION_BODY_MAX);
		expect(String(payload.body)).not.toContain('bob@example.com');
		expect(payload.url).toBe('https://lair.example/admin/jobs');
	});

	it('a hand-written row cannot widen the caps on read', () => {
		const read = readNotificationPayload({
			title: 'x'.repeat(500),
			body: 'y'.repeat(500),
			url: 'https://lair.example/path?secret=1'
		});
		expect(read.title).toHaveLength(NOTIFICATION_TITLE_MAX);
		expect(read.body).toHaveLength(NOTIFICATION_BODY_MAX);
		expect(read.url).toBe('https://lair.example/path');
	});

	it('tolerates missing fields', () => {
		expect(readNotificationPayload(null)).toEqual({ title: '', body: '' });
	});
});

describe('redactNotificationError', () => {
	it('drops DSN credentials, URLs and addresses and stays one line', () => {
		const text = redactNotificationError(
			new Error(
				'connect failed postgres://root:pw@db:5432/local for alice@example.com\nat foo.ts:1'
			)
		);
		expect(text).not.toContain('pw@');
		expect(text).not.toContain('/local');
		expect(text).not.toContain('alice@example.com');
		expect(text).not.toContain('\n');
		expect(text.length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX);
	});
});
