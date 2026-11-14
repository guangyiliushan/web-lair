import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W6 review P0: the admin credentials form must fail closed before any
 * authentication work, answer 429/503 with Retry-After, and key its bucket on
 * the address + a hashed email (one NAT cannot lock out the owner).
 */
const mocks = vi.hoisted(() => ({
	signIn: vi.fn(async () => ({
		user: { id: 'u1', role: 'owner', emailVerified: true },
		token: 't'
	})),
	rate: vi.fn(async () => ({ allowed: true, count: 1, unavailable: false }))
}));

vi.mock('$lib/server/auth', () => ({ auth: { api: { signInEmail: mocks.signIn } } }));
vi.mock('$lib/server/config/admin', () => ({
	ADMIN_BASE_PATH: '/admin',
	ADMIN_HOME_PATH: '/admin/dashboard',
	assertAdminSlug: () => ({
		loginPath: '/admin/login',
		twoFactorPath: '/admin/login/two-factor'
	})
}));
vi.mock('$lib/server/authz', () => ({
	getUserRole: () => 'owner',
	hasAnyAdminCapability: async () => true
}));
vi.mock('$lib/server/auth/site-organization', () => ({
	isSiteOrganizationMember: async () => true
}));
vi.mock('$lib/server/auth/sessions', () => ({ pruneOtherSessions: async () => {} }));
vi.mock('$lib/server/safe-redirect', () => ({
	safeRedirect: (_value: string | null | undefined, fallback: string) => fallback
}));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({ rateLimitStrict: mocks.rate }));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));

import { actions } from './+page.server';

function event() {
	const body = new FormData();
	body.set('email', 'Owner@Example.com');
	body.set('password', 'secret');
	return {
		params: { adminSlug: 'login' },
		request: new Request('http://localhost/admin/login', { method: 'POST', body }),
		url: new URL('http://localhost/admin/login'),
		getClientAddress: () => '203.0.113.9',
		setHeaders: vi.fn()
	} as never;
}

const signIn = actions.signIn as (event: never) => Promise<{ status?: number }>;

beforeEach(() => {
	mocks.signIn.mockClear();
	mocks.rate.mockResolvedValue({ allowed: true, count: 1, unavailable: false });
});

describe('admin login rate guard', () => {
	it('answers 429 + Retry-After and never authenticates when throttled', async () => {
		mocks.rate.mockResolvedValueOnce({ allowed: false, count: 11, unavailable: false });
		const ev = event() as unknown as { setHeaders: ReturnType<typeof vi.fn> };
		const result = await signIn(ev as never);
		expect(result).toMatchObject({ status: 429 });
		expect(ev.setHeaders).toHaveBeenCalledWith({ 'retry-after': '900' });
		expect(mocks.signIn).not.toHaveBeenCalled();
		expect(mocks.rate).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringMatching(/^limits:admin-login:4:cb007109:[0-9a-f]{16}$/),
			10,
			900
		);
	});

	it('fails closed with 503 when the limiter store is offline', async () => {
		mocks.rate.mockResolvedValueOnce({ allowed: false, count: 0, unavailable: true });
		const result = await signIn(event());
		expect(result).toMatchObject({ status: 503 });
		expect(mocks.signIn).not.toHaveBeenCalled();
	});
});
