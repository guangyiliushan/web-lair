import { error } from '@sveltejs/kit';
import type { AdminRole } from '$lib/server/auth/owner';

/**
 * Settings permission matrix (M4 foundation, W3.6a; decision register §3K).
 *
 * Two levels:
 *   - section tier  - what the page itself is for (profile/storage are owner
 *     control planes; integrations is a read-only capability map)
 *   - field tier    - the narrower owner-only fields inside an admin section
 *     (languages, privacy, webhook secrets, storage credentials/purge)
 *
 * Loads use `settingAccess` to decide whether to render an edit affordance;
 * every action MUST re-check with `assertSettingWrite` (the layout guard does
 * not run before a form action). `read` never permits a write.
 */
export type SettingSection =
	'profile' | 'site' | 'content' | 'notifications' | 'integrations' | 'storage' | 'ai' | 'account';

export type SettingTier = 'owner' | 'admin' | 'read';

export const SETTING_TIERS: Record<SettingSection, SettingTier> = {
	profile: 'owner',
	site: 'admin',
	content: 'admin',
	notifications: 'admin',
	integrations: 'read',
	storage: 'owner',
	ai: 'admin',
	account: 'admin'
};

/**
 * Owner-only fields inside an otherwise admin section. Keys are stable
 * `section.field` identifiers, not option names, so moving a page does not
 * silently widen a credential boundary.
 */
export const SETTING_FIELD_TIERS: Record<string, SettingTier> = {
	'profile.public_identity': 'owner',
	'profile.header_label': 'owner',
	'profile.home_hero': 'owner',
	'profile.content_language': 'owner',
	'site.info': 'admin',
	'site.icon': 'admin',
	'site.timezone': 'admin',
	'site.languages': 'owner',
	'site.default_lang': 'owner',
	'comments.enabled': 'admin',
	'comments.privacy': 'owner',
	'friends.apply': 'admin',
	'friends.checks': 'admin',
	'friends.policy': 'admin',
	'presence.enabled': 'admin',
	'presence.readerView': 'admin',
	'presence.readerDots': 'admin',
	'notes.gate': 'admin',
	'notifications.mail': 'admin',
	'notifications.webhooks': 'owner',
	'storage.provider': 'owner',
	'storage.credentials': 'owner',
	'storage.purge': 'owner',
	'storage.migration': 'owner',
	'ai.providers': 'admin',
	'ai.budget': 'admin',
	'ai.secrets': 'owner',
	'account.self': 'admin'
};

export interface SettingAccess {
	tier: SettingTier;
	editable: boolean;
}

export function settingTier(section: SettingSection, field?: string): SettingTier {
	if (field) return SETTING_FIELD_TIERS[field] ?? SETTING_TIERS[section];
	return SETTING_TIERS[section];
}

export function settingAccess(
	role: AdminRole | null | undefined,
	section: SettingSection,
	field?: string
): SettingAccess {
	const tier = settingTier(section, field);
	const editable =
		tier === 'read'
			? false
			: tier === 'owner'
				? role === 'owner'
				: role === 'owner' || role === 'admin';
	return { tier, editable };
}

/**
 * Action-side re-check. Call it after `requireAdminRole()`; it throws 403 when
 * the current role cannot write the section/field. The role is passed in (not
 * read from a request-global) so the guard is deterministic in route tests.
 */
export function assertSettingWrite(
	role: AdminRole | null | undefined,
	section: SettingSection,
	field?: string
): void {
	const { tier, editable } = settingAccess(role, section, field);
	if (editable) return;
	error(403, {
		message:
			tier === 'read'
				? 'This settings section is read-only.'
				: 'Only the site owner can change this setting.'
	});
}
