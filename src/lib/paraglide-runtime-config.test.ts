import { describe, expect, it } from 'vitest';
import {
	isExcludedByRouteStrategy,
	routeStrategies,
	strategy,
	urlPatterns
} from '$lib/paraglide/runtime';
import { cookieSurfaceMatches, excludedSurfaceMatches } from '$lib/config/locale-surfaces';

/**
 * Config-drift canary for the generated paraglide runtime (P3-a). The vite
 * plugin bakes `strategy` / `urlPatterns` / `routeStrategies` into
 * runtime.js and recompiles the artifact on every vite/vitest run, so this
 * locks the *configured* routing: a future edit to vite.config.ts — or a
 * regeneration through the bare `paraglide-js compile` CLI, which cannot
 * carry urlPatterns/routeStrategies — must not silently drop the url-first
 * chain, the prefix-all patterns or the route strategies.
 *
 * P3-b: the middleware overrides are derived from
 * `$lib/config/locale-surfaces` (shared with the runtime link helper), so
 * the generated runtime must match that module exactly — both directions.
 */
describe('paraglide runtime configuration', () => {
	it('chains the url strategy first', () => {
		expect(strategy).toEqual(['url', 'cookie', 'preferredLanguage', 'baseLocale']);
	});

	it('prefixes every locale and keeps the bare-locale identity patterns first', () => {
		expect(urlPatterns.slice(0, 3)).toEqual([
			{ pattern: '/en', localized: [['en', '/en']] },
			{ pattern: '/zh-cn', localized: [['zh-cn', '/zh-cn']] },
			{ pattern: '/ja', localized: [['ja', '/ja']] }
		]);

		const wildcard = urlPatterns.find((element) => element.pattern.includes(':protocol'));
		expect(wildcard).toBeDefined();
		const localized = Object.fromEntries(wildcard!.localized);
		expect(localized['en']).toContain('/en/');
		expect(localized['zh-cn']).toContain('/zh-cn/');
		expect(localized['ja']).toContain('/ja/');
	});

	it('derives the exempt surfaces from the shared locale-surfaces module', () => {
		const expected = [...cookieSurfaceMatches(), ...excludedSurfaceMatches()];
		const matches = routeStrategies.map((entry) => entry.match);

		// Bidirectional check: no missing and no extra middleware overrides.
		expect([...matches].sort()).toEqual([...expected].sort());

		const cookieEntries = routeStrategies.filter((entry) => entry.exclude !== true);
		expect(cookieEntries).not.toHaveLength(0);
		for (const entry of cookieEntries) {
			expect(entry.strategy, entry.match).toEqual(['cookie', 'preferredLanguage', 'baseLocale']);
		}

		const excluded = routeStrategies
			.filter((entry) => entry.exclude === true)
			.map((entry) => entry.match);
		expect(excluded).toEqual(excludedSurfaceMatches());
	});

	it('pins the runtime exclusion verdict for root files and per-language feeds', () => {
		// Exact patterns also match the de-localised path, so the language
		// feeds are excluded too — handlers there must take the locale from
		// the path (getLocale() is unavailable; review finding).
		for (const url of [
			'http://localhost/sitemap.xml',
			'http://localhost/robots.txt',
			'http://localhost/rss.xml',
			'http://localhost/en/rss.xml',
			'http://localhost/ja/rss.xml'
		]) {
			expect(isExcludedByRouteStrategy(url), url).toBe(true);
		}
		expect(isExcludedByRouteStrategy('http://localhost/en/posts/hello')).toBe(false);
	});
});
