import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'better-auth/api';

/**
 * W1.4/P0-4: the forgot-password action must reach better-auth's
 * `requestPasswordReset` (the only thing that mints a token and calls the
 * `sendResetPassword` mail callback), keep the anti-enumeration answer, and
 * refuse when the transport cannot deliver at all.
 */
const { requestResetMock, mailAvailableMock, mailLiveMock, rateLimitStrictMock } = vi.hoisted(
	() => ({
		requestResetMock: vi.fn(),
		mailAvailableMock: vi.fn(() => true),
		mailLiveMock: vi.fn(async () => true),
		rateLimitStrictMock: vi.fn(async () => ({ allowed: true, count: 1, unavailable: false }))
	})
);

vi.mock('$lib/server/auth', () => ({
	auth: { api: { requestPasswordReset: requestResetMock } }
}));
vi.mock('$lib/server/mail/transport', () => ({
	isMailDeliveryAvailable: mailAvailableMock,
	isMailDeliveryAvailableLive: mailLiveMock
}));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({ rateLimitStrict: rateLimitStrictMock }));
vi.mock('$lib/paraglide/messages', () => ({
	m: {
		auth_forgot_err_email: () => 'err-email',
		auth_forgot_err_rate: () => 'err-rate',
		auth_forgot_mail_unconfigured: () => 'err-mail',
		auth_err_unavailable: () => 'err-unavailable'
	}
}));

import { actions, load } from './+page.server';

type SendResetAction = NonNullable<typeof actions.sendReset>;

function event(fields: Record<string, string> = {}) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/forgot-password', { method: 'POST', body }),
		getClientAddress: () => '203.0.113.9',
		url: new URL('http://localhost/forgot-password'),
		setHeaders: vi.fn()
	};
}

function call(fields: Record<string, string> = {}) {
	return (actions.sendReset as SendResetAction)(event(fields) as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	requestResetMock.mockResolvedValue({ status: true });
	mailAvailableMock.mockReturnValue(true);
	mailLiveMock.mockResolvedValue(true);
	rateLimitStrictMock.mockResolvedValue({ allowed: true, count: 1, unavailable: false });
});

describe('forgot-password action', () => {
	it('rejects a missing address before touching auth or mail', async () => {
		const result = (await call({})) as { status: number; data: { message: string } };
		expect(result.status).toBe(400);
		expect(result.data.message).toBe('err-email');
		expect(requestResetMock).not.toHaveBeenCalled();
	});

	it('asks better-auth for a reset link that lands on our reset route', async () => {
		const result = await call({ email: ' Reader@Example.com ' });

		expect(result).toEqual({ success: true });
		expect(requestResetMock).toHaveBeenCalledTimes(1);
		expect(requestResetMock).toHaveBeenCalledWith({
			body: { email: 'Reader@Example.com', redirectTo: '/reset-password' },
			headers: expect.any(Headers)
		});
	});

	it('keeps the same answer when the address is unknown (APIError)', async () => {
		requestResetMock.mockRejectedValueOnce(
			APIError.from('BAD_REQUEST', { message: 'Invalid email', code: 'INVALID_EMAIL' })
		);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const result = await call({ email: 'nobody@example.com' });

		expect(result).toEqual({ success: true });
		expect(error).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			'[forgot-password] reset request rejected',
			expect.any(String)
		);
		error.mockRestore();
		warn.mockRestore();
	});

	it('keeps the same answer but logs a transport failure', async () => {
		requestResetMock.mockRejectedValueOnce(new Error('SMTP refused'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await call({ email: 'reader@example.com' });

		expect(result).toEqual({ success: true });
		expect(error).toHaveBeenCalledWith(
			'[forgot-password] reset request failed',
			expect.any(String)
		);
		error.mockRestore();
	});

	it('answers 503 when no mail can be delivered at all', async () => {
		mailLiveMock.mockResolvedValueOnce(false);

		const result = (await call({ email: 'reader@example.com' })) as {
			status: number;
			data: { message: string };
		};

		expect(result.status).toBe(503);
		expect(result.data.message).toBe('err-mail');
		expect(requestResetMock).not.toHaveBeenCalled();
	});

	it('caps reset mails per client address', async () => {
		rateLimitStrictMock.mockResolvedValueOnce({
			allowed: false,
			count: 6,
			unavailable: false
		});

		const result = (await call({ email: 'reader@example.com' })) as {
			status: number;
			data: { message: string };
		};

		expect(result.status).toBe(429);
		expect(result.data.message).toBe('err-rate');
		expect(rateLimitStrictMock).toHaveBeenCalledWith(
			expect.anything(),
			'limits:password-reset:4:cb007109',
			5,
			3600
		);
		expect(requestResetMock).not.toHaveBeenCalled();
	});

	it('fails closed with 503 when the limiter store is down (W6.10)', async () => {
		rateLimitStrictMock.mockResolvedValueOnce({
			allowed: false,
			count: 0,
			unavailable: true
		});
		const result = (await call({ email: 'reader@example.com' })) as {
			status: number;
			data: { message: string };
		};
		expect(result.status).toBe(503);
		expect(result.data.message).toBe('err-unavailable');
		expect(requestResetMock).not.toHaveBeenCalled();
	});

	it('reports whether the page can offer the form at all', () => {
		mailAvailableMock.mockReturnValueOnce(false);
		expect((load as () => { mailConfigured: boolean })()).toEqual({ mailConfigured: false });
	});
});
