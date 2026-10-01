import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for /robots.txt (P3-b): ORIGIN drives the Sitemap line
 * when set (normalised via URL), the request origin is the dev fallback,
 * and the body stays minimal (no Disallow/Crawl-delay).
 */
const { envState } = vi.hoisted(() => ({
	envState: { env: {} as Record<string, string | undefined> }
}));

vi.mock('$env/dynamic/private', () => envState);

import { GET } from './+server';

function event(url = 'https://example.com/robots.txt') {
	return { url: new URL(url) } as never;
}

describe('robots route', () => {
	beforeEach(() => {
		envState.env.ORIGIN = 'https://example.com/';
	});

	it('serves the minimal policy with the Sitemap line from ORIGIN', async () => {
		const response = await GET(event());

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toBe('User-agent: *\n\nSitemap: https://example.com/sitemap.xml\n');
		expect(body).not.toContain('Disallow');
		expect(body).not.toContain('Crawl-delay');
		expect(response.headers.get('content-type')).toContain('text/plain');
	});

	it('falls back to the request origin when ORIGIN is unset (pnpm dev)', async () => {
		delete envState.env.ORIGIN;

		const response = await GET(event('http://localhost:5173/robots.txt'));
		expect(await response.text()).toBe(
			'User-agent: *\n\nSitemap: http://localhost:5173/sitemap.xml\n'
		);
	});
});
