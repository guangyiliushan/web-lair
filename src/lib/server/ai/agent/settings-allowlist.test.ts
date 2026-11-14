import { describe, expect, it } from 'vitest';
import { SETTING_KEYS, SETTING_TIERS } from './settings-allowlist';

/**
 * W6.9 (C8): the admin assistant's setting surface is a strict subset of the
 * settings pages. Comment privacy (owner), the new comment/friends keys and
 * the contract-only payments flag must never be writable through a proposal.
 */
describe('agent setting allowlist', () => {
	it('keeps the owner-only and new W6 keys out', () => {
		const forbidden = [
			'comments.enabled',
			'comments.privacy',
			'friends.apply',
			'friends.checks',
			'friends.policy',
			'payments.enabled',
			'presence.readerView',
			'presence.readerDots'
		];
		for (const key of forbidden) {
			expect(SETTING_KEYS as readonly string[], key).not.toContain(key);
			expect(SETTING_TIERS[key], key).toBeUndefined();
		}
	});

	it('keeps the deliberate tier1 dual-write keys', () => {
		expect(SETTING_KEYS as readonly string[]).toContain('presence.enabled');
		expect(SETTING_KEYS as readonly string[]).toContain('notes.gate');
		expect(SETTING_TIERS['presence.enabled']).toBe('tier1');
		expect(SETTING_TIERS['notes.gate']).toBe('tier1');
	});

	it('leaves comment moderation single-writer on the AI page', () => {
		expect(SETTING_KEYS as readonly string[]).toContain('comments.moderation');
		expect(SETTING_TIERS['comments.moderation']).toBe('tier1');
	});

	it('gives every allowlisted key a tier', () => {
		for (const key of SETTING_KEYS) expect(SETTING_TIERS[key], key).toBeDefined();
	});
});
