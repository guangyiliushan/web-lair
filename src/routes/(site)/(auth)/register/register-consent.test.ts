import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Registration consent is enforced by the action, not by the browser's `required`
 * attribute: a missing or forged value never reaches better-auth.
 */
const mocks = vi.hoisted(() => ({
	signUp: vi.fn(async () => ({})),
	mailLive: vi.fn(async () => true),
	rate: vi.fn(async () => ({ allowed: true, count: 1, unavailable: false }))
}));

vi.mock('$lib/server/auth', () => ({ auth: { api: { signUpEmail: mocks.signUp } } }));
vi.mock('$lib/server/mail/transport', () => ({
	isMailDeliveryAvailable: () => true,
	isMailDeliveryAvailableLive: mocks.mailLive
}));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({ rateLimitStrict: mocks.rate }));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));

import { actions } from './+page.server';

function event(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/register', { method: 'POST', body }),
		getClientAddress: () => '203.0.113.9',
		setHeaders: vi.fn(),
		url: new URL('http://localhost/register')
	} as never;
}

function valid(extra: Record<string, string> = {}) {
	return {
		name: 'Reader',
		email: 'reader@example.com',
		password: 'correct horse battery',
		confirmPassword: 'correct horse battery',
		...extra
	};
}

const signUp = actions.signUp as (event: never) => Promise<unknown>;

beforeEach(() => {
	mocks.signUp.mockClear();
	mocks.mailLive.mockResolvedValue(true);
	mocks.rate.mockResolvedValue({ allowed: true, count: 1, unavailable: false });
});

describe('register privacy consent', () => {
	it('rejects a missing consent before calling better-auth', async () => {
		const result = (await signUp(event(valid()))) as { status: number };
		expect(result.status).toBe(400);
		expect(mocks.signUp).not.toHaveBeenCalled();
	});

	it('rejects a forged/off value instead of accepting any non-null field', async () => {
		const result = (await signUp(event(valid({ privacyConsent: 'off' })))) as {
			status: number;
		};
		expect(result.status).toBe(400);
		expect(mocks.signUp).not.toHaveBeenCalled();
	});

	it('creates the account when consent is on', async () => {
		await expect(signUp(event(valid({ privacyConsent: 'on' })))).rejects.toMatchObject({
			status: 302
		});
		expect(mocks.signUp).toHaveBeenCalledWith({
			body: { email: 'reader@example.com', password: 'correct horse battery', name: 'Reader' }
		});
	});
});
