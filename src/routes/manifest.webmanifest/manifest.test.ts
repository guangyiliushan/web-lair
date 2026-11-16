import { beforeEach, describe, expect, it, vi } from 'vitest';

const { optionState, failMode } = vi.hoisted(() => ({
	optionState: {
		'site.info': { name: 'Example Site', description: '', avatar: '' }
	} as Record<string, unknown>,
	failMode: { fail: false }
}));

vi.mock('$lib/server/config/options-registry', () => ({
	getOption: async (key: string) => {
		if (failMode.fail) throw new Error('db down');
		return optionState[key];
	}
}));

import { GET } from './+server';

async function manifest(): Promise<Response> {
	return (await GET({} as never)) as Response;
}

describe('GET /manifest.webmanifest', () => {
	beforeEach(() => {
		failMode.fail = false;
		optionState['site.info'] = { name: 'Example Site', description: '', avatar: '' };
	});

	it('serves a minimal manifest with the site name as name and short_name', async () => {
		const response = await manifest();
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/manifest+json');
		await expect(response.json()).resolves.toEqual({
			name: 'Example Site',
			short_name: 'Example Site',
			start_url: '/',
			display: 'standalone'
		});
	});

	it('serves the default name when settings are unavailable (no 500)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		failMode.fail = true;
		const response = await manifest();
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ name: 'Web Lair' });
		warn.mockRestore();
	});

	it('is cacheable for a short window', async () => {
		const response = await manifest();
		expect(response.headers.get('cache-control')).toBe('public, max-age=300');
	});
});
