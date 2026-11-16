import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/robots.txt`: ORIGIN drives the Sitemap line when set, the request origin is
 * the dev fallback, and the AI policy groups are emitted as voluntary signals.
 */
const { envState } = vi.hoisted(() => ({
	envState: { env: {} as Record<string, string | undefined> }
}));

vi.mock('$env/dynamic/private', () => envState);
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: async () => ({ answerEngine: true, training: true })
}));

import { GET } from './+server';

function event(url = 'https://example.com/robots.txt') {
	return { url: new URL(url) } as never;
}

describe('robots route', () => {
	beforeEach(() => {
		envState.env.ORIGIN = 'https://example.com/';
	});

	it('serves the Sitemap line from ORIGIN and the AI groups', async () => {
		const response = await GET(event());

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('User-agent: *');
		expect(body).toContain('Sitemap: https://example.com/sitemap.xml');
		expect(body).toContain('User-agent: GPTBot');
		expect(body).toContain('User-agent: OAI-SearchBot');
		expect(body).not.toContain('Crawl-delay');
		expect(response.headers.get('content-type')).toContain('text/plain');
	});

	it('falls back to the request origin when ORIGIN is unset (pnpm dev)', async () => {
		delete envState.env.ORIGIN;

		const response = await GET(event('http://localhost:5173/robots.txt'));
		expect(await response.text()).toContain('Sitemap: http://localhost:5173/sitemap.xml');
	});
});
