import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rateLimitMock, unsubscribeMock } = vi.hoisted(() => ({
	rateLimitMock: vi.fn(async () => ({ allowed: true, count: 1 })),
	unsubscribeMock: vi.fn(async () => 'unsubscribed')
}));

vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({ rateLimit: rateLimitMock }));
vi.mock('$lib/server/services/subscriptions', () => ({ unsubscribe: unsubscribeMock }));

import { POST } from './+server';

const TOKEN = 'a'.repeat(43);

function event(token: string | null, ip = '203.0.113.9') {
	return {
		url: new URL(
			token === null
				? 'https://lair.example/api/unsubscribe/one-click'
				: `https://lair.example/api/unsubscribe/one-click?token=${token}`
		),
		getClientAddress: () => ip
	} as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
	rateLimitMock.mockReset();
	rateLimitMock.mockResolvedValue({ allowed: true, count: 1 });
	unsubscribeMock.mockReset();
	unsubscribeMock.mockResolvedValue('unsubscribed');
});

describe('RFC 8058 one-click unsubscribe endpoint', () => {
	it('unsubscribes a well-formed token and answers 200 with an empty body', async () => {
		const response = await POST(event(TOKEN));
		expect(unsubscribeMock).toHaveBeenCalledWith(TOKEN);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(rateLimitMock).toHaveBeenCalledWith(
			expect.anything(),
			'limits:unsubscribe-oneclick:203.0.113.9',
			30,
			60
		);
	});

	it('answers 200 for a malformed or missing token without touching the service', async () => {
		expect((await POST(event('short'))).status).toBe(200);
		expect((await POST(event(null))).status).toBe(200);
		expect(unsubscribeMock).not.toHaveBeenCalled();
	});

	it('answers 200 for an unknown but well-formed token (no oracle)', async () => {
		unsubscribeMock.mockResolvedValueOnce('invalid');
		expect((await POST(event(TOKEN))).status).toBe(200);
		expect(unsubscribeMock).toHaveBeenCalledWith(TOKEN);
	});

	it('answers 429 when the per-IP seatbelt trips, without unsubscribing', async () => {
		rateLimitMock.mockResolvedValueOnce({ allowed: false, count: 31 });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const response = await POST(event(TOKEN));
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('60');
		expect(unsubscribeMock).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('answers 503 on a database failure so the receiver retries', async () => {
		unsubscribeMock.mockRejectedValueOnce(new Error('db down'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const response = await POST(event(TOKEN));
		expect(response.status).toBe(503);
		expect(response.headers.get('retry-after')).toBe('60');
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});
