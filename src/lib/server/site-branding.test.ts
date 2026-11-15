import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { optionState, failMode, fetchMode } = vi.hoisted(() => ({
	optionState: {
		'site.info': { name: 'Example Site', description: '', avatar: '' },
		'site.icon': { url: 'https://cdn.example/favicon.svg', version: 3 }
	} as Record<string, unknown>,
	failMode: { fail: false },
	fetchMode: {
		impl: null as null | (() => Promise<Response>)
	}
}));

vi.mock('$lib/server/config/options-registry', () => ({
	getOption: async (key: string) => {
		if (failMode.fail) throw new Error('db down');
		return optionState[key];
	}
}));

import { loadSiteBranding, SITE_BRANDING_DEFAULT } from './site-branding';

const OK_IMAGE = () =>
	Promise.resolve(
		new Response(null, { status: 200, headers: { 'content-type': 'image/svg+xml' } })
	);

describe('loadSiteBranding (W5.3)', () => {
	beforeEach(() => {
		failMode.fail = false;
		fetchMode.impl = OK_IMAGE;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => fetchMode.impl!())
		);
		optionState['site.info'] = { name: 'Example Site', description: '', avatar: '' };
		optionState['site.icon'] = { url: 'https://cdn.example/favicon.svg', version: 3 };
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns the stored name and icon', async () => {
		await expect(loadSiteBranding()).resolves.toEqual({
			name: 'Example Site',
			icon: { url: 'https://cdn.example/favicon.svg', version: 3 }
		});
	});

	it('falls back to the bundled icon when the external icon is 404', async () => {
		fetchMode.impl = () => Promise.resolve(new Response(null, { status: 404 }));
		optionState['site.icon'] = { url: 'https://cdn.example/missing.ico', version: 1 };
		await expect(loadSiteBranding()).resolves.toEqual({
			name: 'Example Site',
			icon: { url: '', version: 1 }
		});
	});

	it('falls back when a 2xx is not an image (typo pointing at an HTML page)', async () => {
		fetchMode.impl = () =>
			Promise.resolve(
				new Response(null, { status: 200, headers: { 'content-type': 'text/html' } })
			);
		optionState['site.icon'] = { url: 'https://cdn.example/page.html', version: 1 };
		await expect(loadSiteBranding()).resolves.toMatchObject({ icon: { url: '' } });
	});

	it('keeps the stored icon when the probe times out or the host is unreachable', async () => {
		fetchMode.impl = () => Promise.reject(new Error('timeout'));
		optionState['site.icon'] = { url: 'https://cdn.example/slow.ico', version: 1 };
		await expect(loadSiteBranding()).resolves.toMatchObject({
			icon: { url: 'https://cdn.example/slow.ico', version: 1 }
		});
	});

	it('never probes the bundled or same-origin icon', async () => {
		optionState['site.icon'] = { url: '/i/favicon.ico', version: 2 };
		await loadSiteBranding();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('falls back to the defaults (with a warning) instead of 500ing every page', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		failMode.fail = true;

		await expect(loadSiteBranding()).resolves.toEqual(SITE_BRANDING_DEFAULT);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('treats an empty stored name as unset', async () => {
		optionState['site.info'] = { name: '', description: '', avatar: '' };
		await expect(loadSiteBranding()).resolves.toMatchObject({ name: 'Web Lair' });
	});

	it('hands out a fresh default object (mutation-safe)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		failMode.fail = true;
		const first = await loadSiteBranding();
		first.icon.url = 'mutated';
		const second = await loadSiteBranding();
		expect(second.icon.url).toBe('');
		warn.mockRestore();
	});
});
