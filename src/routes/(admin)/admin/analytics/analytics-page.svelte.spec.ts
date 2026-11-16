import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import AdminAnalytics from './+page.svelte';

overwriteGetLocale(() => 'en');

const PATH = {
	path: '/posts/missing-page',
	app: 'lair.example',
	requests: 2,
	bytes_out: 1600,
	s4xx: 2,
	s5xx: 0,
	p50: 3,
	p95: 4
};

function mount(traffic: unknown) {
	return render(AdminAnalytics, {
		data: {
			headerTitle: 'Analytics',
			range: '24h',
			generatedAt: new Date().toISOString(),
			traffic
		} as never
	});
}

const TRAFFIC = {
	summary: {
		pageRequests: 6,
		topPages: [PATH, { ...PATH, path: '/about', requests: 1, s4xx: 0 }],
		topErrorPaths: [PATH],
		notFoundRequests: 2,
		pathsTruncated: false
	},
	overview: {
		requests: 11,
		uniqueVisitors: 8,
		p95: 11.5,
		status: { s2xx: 9, s3xx: 0, s4xx: 2, s5xx: 0 }
	},
	series: [
		{ bucket: 1, requests: 1 },
		{ bucket: 2, requests: 4 }
	],
	referers: [{ value: 'https://ref.example/', requests: 10, bytes_out: 1 }],
	browsers: [{ value: 'Firefox', requests: 10, bytes_out: 1 }],
	devices: [{ value: 'desktop', requests: 10, bytes_out: 1 }],
	attribution: null
};

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	document.body.innerHTML = '';
	overwriteGetLocale(() => 'en');
});

describe('admin analytics page', () => {
	it('renders page requests, exact 404s and the filtered page tables', async () => {
		await mount(TRAFFIC);
		const text = document.body.textContent ?? '';
		expect(text).toContain('Page requests');
		expect(text).toContain('404 requests');
		expect(text).toContain('/posts/missing-page');
		expect(text).toContain('Top 404 / 4xx pages');
		// "Visits"/"Views" are the labels this metric must never use.
		expect(text).not.toContain('Today Views');
		expect(text.toLowerCase()).not.toMatch(/\bviews?\b/);
	});

	it('shows the lower-bound banner when paths are truncated', async () => {
		await mount({
			...TRAFFIC,
			summary: { ...TRAFFIC.summary, pathsTruncated: true }
		});
		expect(document.body.textContent).toContain("Sentinel's long tail");
	});

	it('uses 页面请求 in the zh-cn locale', async () => {
		overwriteGetLocale(() => 'zh-cn');
		await mount(TRAFFIC);
		expect(document.body.textContent).toContain('页面请求');
	});

	it('renders the unavailable notice and em dashes when Sentinel is down', async () => {
		await mount(null);
		const text = document.body.textContent ?? '';
		expect(text).toContain('Traffic data unavailable');
		expect(text).toContain('—');
		expect(text).not.toContain('/posts/missing-page');
	});
});
