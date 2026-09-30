import { describe, expect, it } from 'vitest';
import { routeStrategies, strategy, urlPatterns } from '$lib/paraglide/runtime';

/**
 * Config-drift canary for the generated runtime (P3-a). The vite plugin
 * bakes `strategy` / `urlPatterns` / `routeStrategies` into runtime.js, but
 * the bare `paraglide-js compile` CLI cannot carry urlPatterns or
 * routeStrategies — regenerating with it silently reverts this
 * configuration. These assertions fail loudly in that case.
 */
describe('paraglide runtime configuration', () => {
	it('chains the url strategy first', () => {
		expect(strategy[0]).toBe('url');
		expect(strategy).toContain('cookie');
		expect(strategy).toContain('preferredLanguage');
		expect(strategy).toContain('baseLocale');
	});

	it('prefixes every locale and keeps the bare-locale patterns first', () => {
		const patterns = urlPatterns.map((element) => element.pattern);
		expect(patterns.slice(0, 3)).toEqual(['/en', '/zh-cn', '/ja']);

		const wildcard = urlPatterns.find((element) => element.pattern.includes(':protocol'));
		expect(wildcard).toBeDefined();
		const localized = wildcard!.localized.map(([locale]) => locale);
		expect(localized).toContain('en');
		expect(localized).toContain('zh-cn');
		expect(localized).toContain('ja');
	});

	it('keeps the exempt surfaces and the middleware exclusions', () => {
		const matches = routeStrategies.map((entry) => entry.match);
		for (const expected of [
			'/',
			'/account',
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
	});
});
