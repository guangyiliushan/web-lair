import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Subscribe action (D-2, §F #9): honeypot first, validation before the
 * service, fail-open rate limiting, an indistinguishable success for
 * pending/already-subscribed, and a visible 503 when the confirmation mail
 * cannot be sent.
 */
const { state, requestSubscriptionMock, sendMailMock, rateLimitMock, discardMock } = vi.hoisted(
	() => {
		const state = {
			env: { ORIGIN: 'https://lair.example' } as Record<string, string>,
			locale: 'zh-cn'
		};
		const requestSubscriptionMock = vi.fn();
		const sendMailMock = vi.fn();
		const rateLimitMock = vi.fn(async () => ({ allowed: true, count: 1 }));
		const discardMock = vi.fn(async () => {});
		return { state, requestSubscriptionMock, sendMailMock, rateLimitMock, discardMock };
	}
);

vi.mock('$env/dynamic/private', () => ({ env: state.env }));
vi.mock('$lib/paraglide/runtime', () => ({ getLocale: () => state.locale }));
vi.mock('$lib/paraglide/messages', () => ({
	m: {
		subscribe_err_email: () => 'err-email',
		subscribe_err_rate: () => 'err-rate',
		subscribe_err_mail: () => 'err-mail'
	}
}));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({ rateLimit: rateLimitMock }));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/db/system', () => ({ subscriptions: {} }));
vi.mock('$lib/server/services/subscriptions', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/services/subscriptions')>();
	return {
		...actual,
		requestSubscription: requestSubscriptionMock,
		discardPendingToken: discardMock
	};
});
vi.mock('$lib/server/mail/transport', () => ({ sendMailOrDevLog: sendMailMock }));

import { actions } from './+page.server';

function event(fields: Record<string, string>, ip = '203.0.113.7') {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/zh-cn/subscribe', { method: 'POST', body }),
		getClientAddress: () => ip
	} as unknown as Parameters<typeof actions.default>[0];
}

beforeEach(() => {
	requestSubscriptionMock.mockReset();
	discardMock.mockReset();
	sendMailMock.mockReset();
	sendMailMock.mockResolvedValue(undefined);
	rateLimitMock.mockReset();
	rateLimitMock.mockResolvedValue({ allowed: true, count: 1 });
});

describe('subscribe action', () => {
	it('silently accepts the honeypot without touching the service', async () => {
		const result = await actions.default(event({ email: 'a@b.co', website: 'bot' }));
		expect(result).toEqual({ success: true });
		expect(requestSubscriptionMock).not.toHaveBeenCalled();
		expect(sendMailMock).not.toHaveBeenCalled();
	});

	it('rejects an invalid address before any service call', async () => {
		const result = (await actions.default(event({ email: 'nope' }))) as {
			status: number;
			data: { message: string };
		};
		expect(result.status).toBe(400);
		expect(result.data.message).toBe('err-email');
		expect(requestSubscriptionMock).not.toHaveBeenCalled();
	});

	it('returns 429 when the per-address bucket is exhausted', async () => {
		rateLimitMock.mockResolvedValueOnce({ allowed: false, count: 11 });
		const result = (await actions.default(event({ email: 'a@b.co' }))) as {
			status: number;
			data: { message: string };
		};
		expect(result.status).toBe(429);
		expect(result.data.message).toBe('err-rate');
		expect(rateLimitMock).toHaveBeenCalledWith(
			expect.anything(),
			'limits:subscribe:203.0.113.7',
			10,
			3600
		);
		expect(requestSubscriptionMock).not.toHaveBeenCalled();
	});

	it('sends the confirmation link with the reader locale and reports success', async () => {
		requestSubscriptionMock.mockResolvedValueOnce({ kind: 'pending', token: 'tok_1' });
		const result = await actions.default(event({ email: ' Reader@Example.com ' }));
		expect(result).toEqual({ success: true });
		expect(requestSubscriptionMock).toHaveBeenCalledWith({
			email: 'reader@example.com',
			lang: 'zh-cn',
			source: 'subscribe-page'
		});
		expect(sendMailMock).toHaveBeenCalledTimes(1);
		expect(sendMailMock).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'reader@example.com',
				subject: '确认订阅',
				text: expect.stringContaining('https://lair.example/zh-cn/subscribe/confirm?token=tok_1')
			})
		);
		expect(sendMailMock.mock.calls[0]![0].text).toContain(
			'https://lair.example/zh-cn/unsubscribe?token=tok_1'
		);
	});

	it('falls back to English for a locale outside the supported set', async () => {
		state.locale = 'de';
		requestSubscriptionMock.mockResolvedValueOnce({ kind: 'pending', token: 'tok_2' });
		await actions.default(event({ email: 'a@b.co' }));
		expect(requestSubscriptionMock).toHaveBeenCalledWith(expect.objectContaining({ lang: 'en' }));
		state.locale = 'zh-cn';
	});

	it('does not re-send while a pending link is still inside its cooldown', async () => {
		requestSubscriptionMock.mockResolvedValueOnce({
			kind: 'pending',
			token: 'tok_1',
			send: false
		});
		const result = await actions.default(event({ email: 'a@b.co' }));
		expect(result).toEqual({ success: true });
		expect(sendMailMock).not.toHaveBeenCalled();
	});

	it('does not send a mail for an already-subscribed address but keeps the same answer', async () => {
		requestSubscriptionMock.mockResolvedValueOnce({ kind: 'already-subscribed' });
		const result = await actions.default(event({ email: 'a@b.co' }));
		expect(result).toEqual({ success: true });
		expect(sendMailMock).not.toHaveBeenCalled();
	});

	it('surfaces a 503 when the confirmation mail cannot be sent', async () => {
		requestSubscriptionMock.mockResolvedValueOnce({ kind: 'pending', token: 'tok_1' });
		sendMailMock.mockRejectedValueOnce(new Error('smtp refused'));
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = (await actions.default(event({ email: 'a@b.co' }))) as {
			status: number;
			data: { message: string };
		};
		expect(result.status).toBe(503);
		expect(result.data.message).toBe('err-mail');
		expect(discardMock).toHaveBeenCalledWith('tok_1');
		spy.mockRestore();
	});
});
