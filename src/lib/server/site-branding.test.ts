import { beforeEach, describe, expect, it, vi } from 'vitest';

const { optionState, failMode } = vi.hoisted(() => ({
	optionState: {
		'site.info': { name: 'Example Site', description: '', avatar: '' },
		'site.icon': { url: 'https://cdn.example/favicon.svg', version: 3 }
	} as Record<string, unknown>,
	failMode: { fail: false }
}));

vi.mock('$lib/server/config/options-registry', () => ({
	getOption: async (key: string) => {
		if (failMode.fail) throw new Error('db down');
		return optionState[key];
	}
}));

import { loadSiteBranding, SITE_BRANDING_DEFAULT } from './site-branding';

describe('loadSiteBranding (W5.3)', () => {
	beforeEach(() => {
		failMode.fail = false;
		optionState['site.info'] = { name: 'Example Site', description: '', avatar: '' };
		optionState['site.icon'] = { url: 'https://cdn.example/favicon.svg', version: 3 };
	});

	it('returns the stored name and icon', async () => {
		await expect(loadSiteBranding()).resolves.toEqual({
			name: 'Example Site',
			icon: { url: 'https://cdn.example/favicon.svg', version: 3 }
		});
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
