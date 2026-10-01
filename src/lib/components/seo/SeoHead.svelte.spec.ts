import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

/**
 * Client-side tests for the SEO head (P3-b review findings): the canonical
 * is self-referencing and absolute, alternates default to the same path in
 * every locale, and the origin comes from the (site) layout's ORIGIN when
 * configured — falling back to the request origin otherwise.
 */
const { pageState } = vi.hoisted(() => ({
	pageState: { data: {} as Record<string, unknown> }
}));

vi.mock('$app/state', () => ({
	page: {
		get url() {
			return new URL('http://localhost:4173/en/posts/hello');
		},
		get data() {
			return pageState.data;
		}
	}
}));

// Pin the UI locale for deterministic hrefs (official paraglide escape
// hatch; the browser environment's navigator language is not stable).
overwriteGetLocale(() => 'en');

import SeoHead from './SeoHead.svelte';

function headLinks(rel: string): { hreflang: string | null; href: string | null }[] {
	return [...document.head.querySelectorAll(`link[rel="${rel}"]`)].map((element) => ({
		hreflang: element.getAttribute('hreflang'),
		href: element.getAttribute('href')
	}));
}

afterEach(() => {
	document.head
		.querySelectorAll('link[rel="canonical"], link[rel="alternate"]')
		.forEach((element) => element.remove());
	for (const key of Object.keys(pageState.data)) delete pageState.data[key];
});

describe('SeoHead', () => {
	it('renders a self-referencing canonical and per-locale alternates from the request origin', async () => {
		await render(SeoHead, { props: { path: '/posts/hello' } });

		expect(headLinks('canonical')).toEqual([
			{ hreflang: null, href: 'http://localhost:4173/en/posts/hello' }
		]);
		expect(headLinks('alternate')).toEqual([
			{ hreflang: 'en', href: 'http://localhost:4173/en/posts/hello' },
			{ hreflang: 'zh-cn', href: 'http://localhost:4173/zh-cn/posts/hello' },
			{ hreflang: 'ja', href: 'http://localhost:4173/ja/posts/hello' }
		]);
	});

	it('prefers the single public origin from the layout data (review finding)', async () => {
		pageState.data.siteOrigin = 'https://public.example';
		await render(SeoHead, {
			props: {
				path: '/posts/a',
				alternates: [
					{ lang: 'en', path: '/posts/a' },
					{ lang: 'zh-cn', path: '/posts/a-zh' }
				]
			}
		});

		expect(headLinks('canonical')).toEqual([
			{ hreflang: null, href: 'https://public.example/en/posts/a' }
		]);
		expect(headLinks('alternate')).toEqual([
			{ hreflang: 'en', href: 'https://public.example/en/posts/a' },
			{ hreflang: 'zh-cn', href: 'https://public.example/zh-cn/posts/a-zh' }
		]);
	});
});
