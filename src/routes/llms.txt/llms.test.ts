import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/llms.txt` language wiring: `site.languages` decides which locale paths exist
 * (`/ja/llms.txt` 404s when ja is disabled) while `site.default_lang` only drives
 * the root redirect. Disabling a language must not remove the `/ja/` UI routes —
 * that is Paraglide's job — so only this feed 404s.
 */
const { optionState } = vi.hoisted(() => ({
	optionState: {
		'site.default_lang': 'en',
		'site.languages': { enabled: ['en', 'zh-cn', 'ja'] }
	} as Record<string, unknown>
}));

vi.mock('$lib/server/config/options-registry', () => ({
	getOption: async (key: string) => optionState[key]
}));
vi.mock('$lib/server/llms', () => ({ buildLlmsTxt: async () => '# llms body' }));
vi.mock('$lib/server/origin', () => ({ getPublicOrigin: () => 'https://example.com' }));

import { GET } from './+server';

type HandlerEvent = Parameters<typeof GET>[0];

function request(path: string): HandlerEvent {
	return { url: new URL(`https://example.com${path}`) } as unknown as HandlerEvent;
}

describe('/llms.txt language gating', () => {
	beforeEach(() => {
		optionState['site.default_lang'] = 'en';
		optionState['site.languages'] = { enabled: ['en', 'zh-cn', 'ja'] };
	});

	it('serves an enabled locale', async () => {
		const response = (await GET(request('/ja/llms.txt'))) as Response;
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe('# llms body');
	});

	it('404s a disabled locale without touching the UI routes', async () => {
		optionState['site.languages'] = { enabled: ['en', 'zh-cn'] };
		const response = (await GET(request('/ja/llms.txt'))) as Response;
		expect(response.status).toBe(404);
		await expect(response.text()).resolves.toBe('Not found');
	});

	it('redirects the root to the configured default content language', async () => {
		optionState['site.default_lang'] = 'zh-cn';
		await expect(GET(request('/llms.txt'))).rejects.toMatchObject({
			status: 302,
			location: '/zh-cn/llms.txt'
		});
	});
});
