import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the (site) layout load (second review round): the
 * public origin handed to the SEO head is the SINGLE source shared with the
 * feeds — deleting or bypassing this wiring used to leave every gate green
 * while silently re-introducing the request-origin fallback in production.
 */
const { envState, optionState } = vi.hoisted(() => ({
	envState: { env: {} as Record<string, string | undefined> },
	optionState: {
		enabled: true,
		readerView: true,
		readerDots: false,
		owner: { name: 'Owner', avatar: '/owner.png' },
		ownerStatus: {
			enabled: true,
			kind: 'coding' as const,
			detail: 'VS Code',
			iconUrl: '',
			href: ''
		},
		throwOn: null as string | null
	}
}));

vi.mock('$env/dynamic/private', () => envState);
vi.mock('$lib/server/nav-data', () => ({
	loadPostsMegaData: vi.fn(async () => null),
	loadNotesMegaData: vi.fn(async () => null),
	loadTimelineMegaData: vi.fn(async () => null),
	loadPagesMegaData: vi.fn(async () => null)
}));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async (key: string) => {
		if (optionState.throwOn === key) throw new Error('settings unavailable');
		if (key === 'presence.enabled') return optionState.enabled;
		if (key === 'presence.readerView') return optionState.readerView;
		if (key === 'presence.readerDots') return optionState.readerDots;
		if (key === 'site.owner') return optionState.owner;
		if (key === 'site.ownerStatus') return optionState.ownerStatus;
		throw new Error(`unexpected option key: ${key}`);
	})
}));

import { load } from './+layout.server';

describe('(site) layout server', () => {
	beforeEach(() => {
		delete envState.env.ORIGIN;
		optionState.enabled = true;
		optionState.readerView = true;
		optionState.readerDots = false;
		optionState.throwOn = null;
	});

	it('exposes the public ORIGIN for the SEO head', async () => {
		envState.env.ORIGIN = 'https://public.example';
		const data = (await load({ parent: async () => ({ auth: null }), locals: {} } as never)) as {
			siteOrigin: string | null;
		};
		expect(data.siteOrigin).toBe('https://public.example');
	});

	it('passes null when ORIGIN is unset (SeoHead falls back to the request origin)', async () => {
		const data = (await load({ parent: async () => ({ auth: null }), locals: {} } as never)) as {
			siteOrigin: string | null;
		};
		expect(data.siteOrigin).toBeNull();
	});

	it('exposes the presence config for the shell and the detail widgets (R-7)', async () => {
		const data = (await load({
			parent: async () => ({ auth: null }),
			locals: {}
		} as never)) as {
			presence: { enabled: boolean; readerView: boolean; readerDots: boolean };
		};
		expect(data.presence).toEqual({ enabled: true, readerView: true, readerDots: false });
	});

	it('flips readerDots on for an admin viewer (E2)', async () => {
		const data = (await load({
			parent: async () => ({ auth: null }),
			locals: { admin: { userId: 'admin-1' } }
		} as never)) as { presence: { readerDots: boolean } };
		expect(data.presence.readerDots).toBe(true);
	});

	it('flows a stored false through (enabled reaches the page data)', async () => {
		optionState.enabled = false;
		const data = (await load({
			parent: async () => ({ auth: null }),
			locals: {}
		} as never)) as { presence: { enabled: boolean } };
		expect(data.presence.enabled).toBe(false);
	});

	it('fails open to the registry defaults when a settings read fails', async () => {
		optionState.throwOn = 'presence.readerDots';
		const data = (await load({
			parent: async () => ({ auth: null }),
			locals: {}
		} as never)) as { presence: { enabled: boolean; readerView: boolean; readerDots: boolean } };
		expect(data.presence).toEqual({ enabled: true, readerView: true, readerDots: false });
	});

	it('exposes the public owner badge and ticket independently of the session', async () => {
		const data = (await load({
			parent: async () => ({ auth: null }),
			locals: {}
		} as never)) as {
			siteOwner: { name: string; avatar: string };
			ownerStatus: { enabled: boolean; kind: string };
		};
		expect(data.siteOwner).toEqual({ name: 'Owner', avatar: '/owner.png' });
		expect(data.ownerStatus).toEqual(optionState.ownerStatus);
	});

	it('falls back to the owner defaults when their settings rows cannot be read', async () => {
		optionState.throwOn = 'site.owner';
		const data = (await load({
			parent: async () => ({ auth: null }),
			locals: {}
		} as never)) as {
			siteOwner: { name: string; avatar: string };
			ownerStatus: { enabled: boolean; kind: string };
		};
		expect(data.siteOwner).toEqual({ name: 'Lair', avatar: '' });
		expect(data.ownerStatus.kind).toBe('coding');
	});
});
