import { describe, expect, it } from 'vitest';
import { assertSettingWrite, settingAccess, settingTier, SETTING_TIERS } from './tiers';

describe('settings permission matrix', () => {
	it('allows the owner to edit every writable section', () => {
		for (const section of Object.keys(SETTING_TIERS) as (keyof typeof SETTING_TIERS)[]) {
			expect(settingAccess('owner', section).editable).toBe(section !== 'integrations');
		}
	});

	it('keeps owner control planes read-only for an admin', () => {
		expect(settingAccess('admin', 'profile')).toEqual({ tier: 'owner', editable: false });
		expect(settingAccess('admin', 'storage')).toEqual({ tier: 'owner', editable: false });
		expect(settingAccess('admin', 'notifications', 'notifications.webhooks')).toEqual({
			tier: 'owner',
			editable: false
		});
		expect(settingAccess('admin', 'site', 'site.languages')).toEqual({
			tier: 'owner',
			editable: false
		});
		expect(settingAccess('admin', 'content', 'comments.privacy')).toEqual({
			tier: 'owner',
			editable: false
		});
	});

	it('lets an admin edit admin-tier sections and fields', () => {
		expect(settingAccess('admin', 'site', 'site.info').editable).toBe(true);
		expect(settingAccess('admin', 'content', 'comments.enabled').editable).toBe(true);
		// W6.9: friends, reading presence and the notes gate are admin writes;
		// comment privacy stays owner-only (asserted above).
		expect(settingAccess('admin', 'content', 'friends.apply').editable).toBe(true);
		expect(settingAccess('admin', 'content', 'friends.checks').editable).toBe(true);
		expect(settingAccess('admin', 'content', 'friends.policy').editable).toBe(true);
		expect(settingAccess('admin', 'content', 'presence.enabled').editable).toBe(true);
		expect(settingAccess('admin', 'content', 'presence.readerView').editable).toBe(true);
		expect(settingAccess('admin', 'content', 'notes.gate').editable).toBe(true);
		expect(settingAccess('owner', 'content', 'comments.privacy').editable).toBe(true);
		expect(settingAccess('admin', 'notifications', 'notifications.mail').editable).toBe(true);
		expect(settingAccess('admin', 'account', 'account.self').editable).toBe(true);
		expect(settingAccess('admin', 'ai', 'ai.budget').editable).toBe(true);
	});

	it('never writes a read-only section', () => {
		expect(settingTier('integrations')).toBe('read');
		expect(settingAccess('owner', 'integrations').editable).toBe(false);
		expect(() => assertSettingWrite('owner', 'integrations')).toThrow();
	});

	it('falls back to the section tier for unknown fields', () => {
		expect(settingTier('site', 'site.unknown')).toBe('admin');
		expect(settingTier('storage', 'storage.unknown')).toBe('owner');
	});

	it('throws 403 for a denied write and stays silent for an allowed one', () => {
		const thrown = (() => {
			try {
				assertSettingWrite('admin', 'storage');
			} catch (caught) {
				return caught as { status: number };
			}
		})();
		expect(thrown?.status).toBe(403);
		expect(() => assertSettingWrite('owner', 'storage')).not.toThrow();
		expect(() => assertSettingWrite(null, 'site')).toThrow();
	});
});
