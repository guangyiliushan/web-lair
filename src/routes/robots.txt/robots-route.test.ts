import { describe, expect, it, vi } from 'vitest';

/**
 * Route-level test for /robots.txt (P3-b): ORIGIN drives the Sitemap line,
 * the body stays minimal (no Disallow/Crawl-delay).
 */
vi.mock('$env/dynamic/private', () => ({ env: { ORIGIN: 'https://example.com/' } }));

import { GET } from './+server';

describe('robots route', () => {
	it('serves the minimal policy with the Sitemap line from ORIGIN', async () => {
		const response = await GET({} as never);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toBe('User-agent: *\n\nSitemap: https://example.com/sitemap.xml\n');
		expect(body).not.toContain('Disallow');
		expect(body).not.toContain('Crawl-delay');
		expect(response.headers.get('content-type')).toContain('text/plain');
	});
});
