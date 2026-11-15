import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * W10.4 acceptance: the final eight-page IA (decision register §3K) is
 * complete in code and copy. The settings shell is the single source of the
 * list, so its ids, labels and descriptions are what every surface shows.
 * This pins:
 *   - exactly eight sections, in the agreed order;
 *   - a label and a description per section in all three locales;
 *   - no stale copy from the old 10-page IA (full-text search, Email and Bark
 *     push, backup/image host) in any of those descriptions;
 *   - the eight routes exist.
 */
const LAYOUT = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');
const LOCALES = ['en', 'ja', 'zh-cn'];

/** section id → message key suffix used for its label/description. */
const SECTIONS = [
	['profile', 'user'],
	['site', 'site'],
	['content', 'content'],
	['notifications', 'notification'],
	['integrations', 'integrations'],
	['storage', 'storage'],
	['ai', 'ai'],
	['account', 'account']
] as const;

const MESSAGES = LOCALES.map((locale) => ({
	locale,
	messages: JSON.parse(
		readFileSync(new URL(`../../../../../messages/${locale}.json`, import.meta.url), 'utf8')
	) as Record<string, string>
}));

describe('final eight-page IA (W10.4)', () => {
	it('declares exactly the eight sections in order', () => {
		const ids = [...LAYOUT.matchAll(/id:\s*'([a-z-]+)'/g)].map((match) => match[1]);
		expect(ids).toEqual(SECTIONS.map(([id]) => id));
	});

	it('labels and describes every section in all three locales', () => {
		for (const { locale, messages } of MESSAGES) {
			for (const [id, key] of SECTIONS) {
				expect(messages, `${locale}:${id}`).toHaveProperty(`admin_settings_${key}`);
				expect(messages, `${locale}:${id}`).toHaveProperty(`admin_settings_${key}_desc`);
				expect(messages[`admin_settings_${key}`].trim(), `${locale}:${id}`).not.toBe('');
				expect(messages[`admin_settings_${key}_desc`].trim(), `${locale}:${id}`).not.toBe('');
			}
			const labels = SECTIONS.map(([, key]) => messages[`admin_settings_${key}`]);
			expect(new Set(labels).size, `${locale}: distinct labels`).toBe(SECTIONS.length);
		}
	});

	it('uses the agreed label for Profile & Preferences in every locale', () => {
		const [en] = MESSAGES;
		expect(en.messages.admin_settings_user).toBe('Profile & Preferences');
		expect(MESSAGES[1].messages.admin_settings_user).toBe('プロフィールと環境設定');
		expect(MESSAGES[2].messages.admin_settings_user).toBe('个人资料与偏好');
	});

	it('describes each page by what it really contains', () => {
		const [en] = MESSAGES;
		expect(en.messages.admin_settings_site_desc).toMatch(/SEO/i);
		expect(en.messages.admin_settings_site_desc).toMatch(/deployment/i);
		expect(en.messages.admin_settings_notification_desc).toMatch(/planned/i);
		expect(en.messages.admin_settings_storage_desc).toMatch(/backup/i);
		expect(en.messages.admin_settings_integrations_desc).toMatch(/planned/i);
		expect(en.messages.admin_settings_account_desc).toMatch(/passkey/i);
	});

	it('drops the stale IA copy from every description', () => {
		// The exact claims the old IA shipped; a legitimate future mention of
		// "search engines" on the Site page must not trip this.
		const stale = /full[- ]text|email and bark|backup image host|comment upload|feature toggle/i;
		for (const { locale, messages } of MESSAGES) {
			for (const [, key] of SECTIONS) {
				expect(messages[`admin_settings_${key}_desc`], `${locale}:${key}`).not.toMatch(stale);
			}
		}
	});

	it('keeps the eight routes on disk', () => {
		for (const [id] of SECTIONS) {
			expect(existsSync(new URL(`./${id}/+page.svelte`, import.meta.url)), id).toBe(true);
		}
	});
});
