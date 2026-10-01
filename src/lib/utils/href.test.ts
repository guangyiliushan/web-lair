import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/paraglide/runtime', () => ({
	locales: ['en', 'zh-cn', 'ja'],
	localizeHref: (href: string) => `/xx${href}`
}));

import { siteHref } from './href';

describe('siteHref', () => {
	it('prefixes content paths via localizeHref', () => {
		expect(siteHref('/posts')).toBe('/xx/posts');
		expect(siteHref('/posts/hello')).toBe('/xx/posts/hello');
		expect(siteHref('/timeline?type=note')).toBe('/xx/timeline?type=note');
		expect(siteHref('/rss.xml')).toBe('/xx/rss.xml');
	});

	it('keeps language-free surfaces bare', () => {
		for (const href of [
			'/',
			'/account',
			'/account/security',
			'/admin',
			'/admin/comments',
			'/sitemap.xml',
			'/robots.txt',
			'/api/auth/session',
			'/demo/playwright',
			'/i/uploaded/key.png'
		]) {
			expect(siteHref(href), href).toBe(href);
		}
	});

	it('preserves query and hash suffixes', () => {
		expect(siteHref('/posts/a?x=1#top')).toBe('/xx/posts/a?x=1#top');
		expect(siteHref('/login?redirectTo=%2Fposts')).toBe('/login?redirectTo=%2Fposts');
	});

	it('passes external, protocol-relative and anchor links through', () => {
		for (const href of [
			'https://example.com/x',
			'mailto:a@b.c',
			'#content',
			'//cdn.example.com/x'
		]) {
			expect(siteHref(href), href).toBe(href);
		}
	});

	it('returns already localised paths untouched', () => {
		for (const href of ['/en/posts', '/zh-cn', '/ja/notes/x?page=2']) {
			expect(siteHref(href), href).toBe(href);
		}
	});
});
