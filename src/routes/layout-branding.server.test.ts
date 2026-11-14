import { beforeEach, describe, expect, it, vi } from 'vitest';

const { brandingMock } = vi.hoisted(() => ({
	brandingMock: vi.fn(async () => ({
		name: 'Example Site',
		icon: { url: 'https://cdn.example/favicon.svg', version: 4 }
	}))
}));

vi.mock('$lib/server/site-branding', () => ({ loadSiteBranding: brandingMock }));

import { load } from './+layout.server';

const USER = {
	id: 'u1',
	name: 'Owner',
	email: 'owner@example.com',
	emailVerified: true,
	image: null
};

describe('root layout branding (W5.3)', () => {
	beforeEach(() => {
		brandingMock.mockClear();
	});

	it('carries the site name and icon for anonymous pages (login, error)', async () => {
		const data = (await load({ locals: { user: null, profile: null } } as never)) as unknown as {
			auth: unknown;
			siteName: string;
			siteIcon: unknown;
		};
		expect(data.auth).toBeNull();
		expect(data.siteName).toBe('Example Site');
		expect(data.siteIcon).toEqual({ url: 'https://cdn.example/favicon.svg', version: 4 });
	});

	it('carries the same branding alongside the auth payload', async () => {
		const data = (await load({
			locals: { user: USER, profile: { displayName: 'Owner', avatarUrl: null } }
		} as never)) as unknown as { auth: { user: { id: string } }; siteName: string };
		expect(data.auth.user.id).toBe('u1');
		expect(data.siteName).toBe('Example Site');
		expect(brandingMock).toHaveBeenCalledTimes(1);
	});
});
