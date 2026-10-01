import { describe, expect, it } from 'vitest';
import { cookieSurfaceMatches, excludedSurfaceMatches, isLocaleFreePath } from './locale-surfaces';

describe('cookieSurfaceMatches', () => {
	it('builds the wildcard pattern form for every cookie surface', () => {
		expect(cookieSurfaceMatches()).toEqual([
			'/',
			'/account/:path(.*)?',
			'/login/:path(.*)?',
			'/register/:path(.*)?',
			'/forgot-password/:path(.*)?',
			'/reset-password/:path(.*)?',
			'/verify-email/:path(.*)?',
			'/admin/:path(.*)?'
		]);
	});
});

describe('excludedSurfaceMatches', () => {
	it('matches the i18n middleware skip list', () => {
		expect(excludedSurfaceMatches()).toEqual([
			'/api/:path(.*)?',
			'/demo/:path(.*)?',
			'/i/:path(.*)?',
			'/sitemap.xml',
			'/robots.txt',
			'/rss.xml'
		]);
	});
});

describe('isLocaleFreePath', () => {
	it('accepts the home page and the root files', () => {
		expect(isLocaleFreePath('/')).toBe(true);
		expect(isLocaleFreePath('/sitemap.xml')).toBe(true);
		expect(isLocaleFreePath('/robots.txt')).toBe(true);
	});

	it('accepts exempt and excluded subtrees at their boundaries', () => {
		for (const path of [
			'/account',
			'/account/security',
			'/login',
			'/register',
			'/forgot-password',
			'/reset-password',
			'/verify-email',
			'/admin',
			'/admin/posts/edit',
			'/api/session',
			'/demo/playwright',
			'/i/uploaded/key.png'
		]) {
			expect(isLocaleFreePath(path), path).toBe(true);
		}
	});

	it('rejects lookalikes and content paths', () => {
		for (const path of [
			'/accounts',
			'/administrator',
			'/apiary',
			'/posts',
			'/posts/a-post',
			'/rss.xml',
			'/timeline',
			'/zh-cn/posts'
		]) {
			expect(isLocaleFreePath(path), path).toBe(false);
		}
	});
});
