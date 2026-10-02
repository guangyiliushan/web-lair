import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the (site) layout load (second review round): the
 * public origin handed to the SEO head is the SINGLE source shared with the
 * feeds — deleting or bypassing this wiring used to leave every gate green
 * while silently re-introducing the request-origin fallback in production.
 */
const { envState } = vi.hoisted(() => ({
	envState: { env: {} as Record<string, string | undefined> }
}));

vi.mock('$env/dynamic/private', () => envState);
vi.mock('$lib/server/nav-data', () => ({
	loadPostsMegaData: vi.fn(async () => null),
	loadNotesMegaData: vi.fn(async () => null),
	loadTimelineMegaData: vi.fn(async () => null)
}));

import { load } from './+layout.server';

describe('(site) layout server', () => {
	beforeEach(() => {
		delete envState.env.ORIGIN;
	});

	it('exposes the public ORIGIN for the SEO head', async () => {
		envState.env.ORIGIN = 'https://public.example';
		const data = (await load({ parent: async () => ({ auth: null }) } as never)) as {
			siteOrigin: string | null;
		};
		expect(data.siteOrigin).toBe('https://public.example');
	});

	it('passes null when ORIGIN is unset (SeoHead falls back to the request origin)', async () => {
		const data = (await load({ parent: async () => ({ auth: null }) } as never)) as {
			siteOrigin: string | null;
		};
		expect(data.siteOrigin).toBeNull();
	});
});
