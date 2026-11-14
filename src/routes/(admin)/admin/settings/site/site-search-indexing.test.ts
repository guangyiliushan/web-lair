import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * W5.6 acceptance: Search indexing lives in Site, shows the two real routes,
 * marks IndexNow/Baidu/Bing as planned, and has no key/token input. The
 * standalone `/admin/settings/search` route is gone (merged into Site by
 * IA3); a regression here would resurrect a second place to configure SEO.
 */
const PAGE = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const NAV = readFileSync(new URL('../+layout.svelte', import.meta.url), 'utf8');
const SEARCH_ROUTE = new URL('../search/', import.meta.url);

describe('Site search indexing (W5.6)', () => {
	const section = PAGE.slice(PAGE.indexOf('<!-- Search indexing')).replace(/<!--[\s\S]*?-->/g, '');

	it('links the two routes that actually exist', () => {
		expect(section).toContain('href="/sitemap.xml"');
		expect(section).toContain('href="/robots.txt"');
		expect(existsSync(new URL('../../../../sitemap.xml/', import.meta.url))).toBe(true);
		expect(existsSync(new URL('../../../../robots.txt/', import.meta.url))).toBe(true);
	});

	it('marks IndexNow, Baidu and Bing as planned without a token field', () => {
		expect(section).toContain('name="IndexNow"');
		expect(section).toContain('name="Baidu"');
		expect(section).toContain('name="Bing"');
		expect(section.match(/state="planned"/g)).toHaveLength(3);
		expect(section).not.toContain('<Input');
		expect(section).not.toContain('<input');
		expect(section).not.toContain('type="submit"');
		expect(section).not.toMatch(/name="[^"]*(?:token|key)[^"]*"/i);
	});

	it('has no standalone settings/search route and no nav entry for it', () => {
		expect(existsSync(SEARCH_ROUTE)).toBe(false);
		expect(NAV).not.toMatch(/id:\s*'(?:search|system)'/);
		expect(NAV.match(/id:\s*'/g)).toHaveLength(8);
	});

	it('still says site search is not implemented (SE3)', () => {
		expect(section).toContain('admin_settings_site_not_implemented');
	});
});
