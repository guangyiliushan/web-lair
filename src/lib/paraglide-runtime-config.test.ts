import { describe, expect, it } from 'vitest';
import { routeStrategies, strategy, urlPatterns } from '$lib/paraglide/runtime';

/**
 * Config-drift canary for the generated paraglide runtime (P3-a). The vite
 * plugin bakes `strategy` / `urlPatterns` / `routeStrategies` into
 * runtime.js and recompiles the artifact on every vite/vitest run, so this
 * locks the *configured* routing: a future edit to vite.config.ts — or a
 * regeneration through the bare `paraglide-js compile` CLI, which cannot
 * carry urlPatterns/routeStrategies — must not silently drop the url-first
 * chain, the prefix-all patterns or the route strategies.
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

	it('keeps the exempt surfaces and the middleware exclusions', () => {
		const matches = routeStrategies.map((entry) => entry.match);
		for (const expected of [
			'/',
			'/account/:path(.*)?',
			'/login/:path(.*)?',
			'/register/:path(.*)?',
			'/forgot-password/:path(.*)?',
			'/reset-password/:path(.*)?',
			'/verify-email/:path(.*)?',
			'/admin/:path(.*)?',
			'/api/:path(.*)?',
			'/demo/:path(.*)?',
			'/i/:path(.*)?'
		]) {
			expect(matches).toContain(expected);
		}

		const excluded = routeStrategies
			.filter((entry) => entry.exclude === true)
			.map((entry) => entry.match);
		expect(excluded).toEqual(['/api/:path(.*)?', '/demo/:path(.*)?', '/i/:path(.*)?']);

		const account = routeStrategies.find((entry) => entry.match === '/account/:path(.*)?');
		expect(account?.strategy).toEqual(['cookie', 'preferredLanguage', 'baseLocale']);
	});
});
