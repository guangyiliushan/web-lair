import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS } from '$lib/server/settings/tiers';

/**
 * W5.6 acceptance: Search indexing lives in Site, shows the two real routes,
 * marks IndexNow/Baidu/Bing as planned, and has no key/token input. The
 * standalone `/admin/settings/search` route is gone (merged into Site by
 * IA3); a regression here would resurrect a second place to configure SEO.
 */
const PAGE = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const SEARCH_ROUTE = new URL('../search/', import.meta.url);

/** Parsed locale files, for the W10.2 dead-key and copy audit. */
const LOCALES = ['en', 'ja', 'zh-cn'];
const MESSAGES = LOCALES.map((locale) => ({
	locale,
	messages: JSON.parse(
		readFileSync(new URL(`../../../../../../messages/${locale}.json`, import.meta.url), 'utf8')
	) as Record<string, string>
}));

/** The schema module plus every migration, joined: `search_documents` must not return. */
const SCHEMA_SOURCE = [
	readFileSync(new URL('../../../../../../src/lib/server/db/schema.ts', import.meta.url), 'utf8'),
	...readdirSync(new URL('../../../../../../drizzle/', import.meta.url))
		.filter((name) => name.endsWith('.sql'))
		.map((name) =>
			readFileSync(new URL(`../../../../../../drizzle/${name}`, import.meta.url), 'utf8')
		)
].join('\n');

describe('Site search indexing (W5.6)', () => {
	// Bound the slice to the next comment so a later section cannot inherit
	// these negatives (W10 review: the old slice ran to EOF).
	const start = PAGE.indexOf('<!-- Search indexing');
	const nextComment = start === -1 ? -1 : PAGE.indexOf('<!--', start + 1);
	const section = PAGE.slice(start, nextComment === -1 ? undefined : nextComment).replace(
		/<!--[\s\S]*?-->/g,
		''
	);

	it('links the two routes that actually exist', () => {
		expect(start, 'Search indexing marker').toBeGreaterThan(-1);
		expect(section).toContain('href="/sitemap.xml"');
		expect(section).toContain('href="/robots.txt"');
		expect(existsSync(new URL('../../../../sitemap.xml/', import.meta.url))).toBe(true);
		expect(existsSync(new URL('../../../../robots.txt/', import.meta.url))).toBe(true);
	});

	it('marks IndexNow, Baidu and Bing as planned without a token field', () => {
		expect(section).toContain('admin_settings_site_indexnow');
		expect(section).toContain('admin_settings_site_baidu');
		expect(section).toContain('admin_settings_site_bing');
		expect(section.match(/admin_settings_integrations_planned/g)).toHaveLength(3);
		expect(section).not.toContain('<Input');
		expect(section).not.toContain('<input');
		expect(section).not.toContain('type="submit"');
		expect(section).not.toMatch(/name="[^"]*(?:token|key)[^"]*"/i);
	});

	it('has no standalone settings/search route and no nav entry for it', () => {
		expect(existsSync(SEARCH_ROUTE)).toBe(false);
		expect(SETTINGS_SECTIONS as readonly string[]).not.toContain('search');
		expect(SETTINGS_SECTIONS as readonly string[]).not.toContain('system');
		const ids = [...SETTINGS_SECTIONS];
		expect(ids).toEqual([
			'profile',
			'site',
			'content',
			'notifications',
			'integrations',
			'storage',
			'ai',
			'account'
		]);
	});

	it('still says site search is not implemented (SE3)', () => {
		expect(section).toContain('admin_settings_site_not_implemented');
	});

	it('spells out that site search is a separate project (W10.2)', () => {
		expect(section).toContain('admin_settings_site_site_search_hint');
		for (const { locale, messages } of MESSAGES) {
			expect(messages.admin_settings_site_site_search_hint, locale).toMatch(
				/separate project|別プロジェクト|独立项目/
			);
		}
	});

	it('leaves no search-page message keys behind in any locale', () => {
		for (const { locale, messages } of MESSAGES) {
			expect(
				Object.keys(messages).filter((key) => key.startsWith('admin_settings_search')),
				locale
			).toEqual([]);
			expect(messages, locale).toHaveProperty('admin_settings_site_search_indexing');
		}
	});

	it('does not revive the search_documents table', () => {
		expect(SCHEMA_SOURCE).not.toContain('search_documents');
	});
});
