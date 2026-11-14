import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the (site) layout load (second review round): the
 * public origin handed to the SEO head is the SINGLE source shared with the
 * feeds — deleting or bypassing this wiring used to leave every gate green
 * while silently re-introducing the request-origin fallback in production.
 */
const { envState, optionState, ownerState } = vi.hoisted(() => ({
	envState: { env: {} as Record<string, string | undefined> },
	optionState: {
		enabled: true,
		readerView: true,
		readerDots: false,
		ownerStatus: {
			enabled: true,
			kind: 'coding' as const,
			detail: 'VS Code',
			iconUrl: '',
			href: ''
		},
		throwOn: null as string | null
	},
	ownerState: {
		profile: {
			userId: 'owner-1',
			displayName: 'Owner',
			headerLabel: null as string | null,
			avatarUrl: '/owner.png' as string | null,
			links: null as { platform: string; href: string }[] | null
		},
		throwOn: false
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
		if (key === 'site.ownerStatus') return optionState.ownerStatus;
		throw new Error(`unexpected option key: ${key}`);
	})
}));
vi.mock('$lib/server/services/owner-profile', () => ({
	loadOwnerProfile: vi.fn(async () => {
		if (ownerState.throwOn) throw new Error('settings unavailable');
		return ownerState.profile;
	}),
	ownerProfileToSiteOwner: (profile: { displayName: string; avatarUrl: string | null }) => ({
		name: profile.displayName,
		avatar: profile.avatarUrl ?? ''
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
		ownerState.throwOn = false;
		ownerState.profile = {
			userId: 'owner-1',
			displayName: 'Owner',
			headerLabel: null,
			avatarUrl: '/owner.png',
			links: null
		};
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

	it('exposes the owner social links exactly as stored (single rail source)', async () => {
		ownerState.profile.links = [
			{ platform: 'github', href: 'https://github.com/owner' },
			{ platform: 'email', href: 'mailto:owner@example.com' }
		];
		const data = (await load({
			parent: async () => ({ auth: null }),
			locals: {}
		} as never)) as { ownerLinks: { platform: string; href: string }[] };
		expect(data.ownerLinks).toEqual(ownerState.profile.links);
	});

	it('exposes an empty owner rail when the profile has no links', async () => {
		const data = (await load({
			parent: async () => ({ auth: null }),
			locals: {}
		} as never)) as { ownerLinks: unknown[] };
		expect(data.ownerLinks).toEqual([]);
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

	it('falls back to the owner defaults when the pointer read fails', async () => {
		ownerState.throwOn = true;
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
