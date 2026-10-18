import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envStub, suppressMock } = vi.hoisted(() => ({
	envStub: {} as Record<string, string | undefined>,
	suppressMock: vi.fn(async () => undefined)
}));
vi.mock('$env/dynamic/private', () => ({ env: envStub }));
vi.mock('$lib/server/services/subscriptions', () => ({
	normalizeEmail: (raw: string) => {
		const email = raw.trim().toLowerCase();
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
	}
}));
vi.mock('$lib/server/services/suppressions', () => ({ suppress: suppressMock }));

import { POST } from './+server';

const KEY = Buffer.alloc(32, 7);
const KEY_B64 = KEY.toString('base64');

function signed(
	body: string,
	options: { timestamp?: number; key?: Buffer; signature?: string } = {}
): Request {
	const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
	const signature =
		options.signature ??
		`sha256=${createHmac('sha256', options.key ?? KEY)
			.update(`${timestamp}.${body}`)
			.digest('hex')}`;
	return new Request('https://lair.example/api/mail/events', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-mail-events-timestamp': timestamp,
			'x-mail-events-signature': signature
		},
		body
	});
}

function call(request: Request) {
	return POST({ request } as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	envStub.MAIL_EVENTS_HMAC_KEY = KEY_B64;
	suppressMock.mockReset();
	suppressMock.mockResolvedValue(undefined);
});

describe('mail events endpoint (E2-4)', () => {
	it('accepts a signed bounce and suppresses the address', async () => {
		const response = await call(
			signed(JSON.stringify({ email: 'Bounce@Example.com', reason: 'bounced' }))
		);
		expect(response.status).toBe(200);
		expect(suppressMock).toHaveBeenCalledWith('bounce@example.com', 'bounced', 'mail-events');
	});

	it('accepts a complaint', async () => {
		const response = await call(signed(JSON.stringify({ email: 'a@b.co', reason: 'complained' })));
		expect(response.status).toBe(200);
		expect(suppressMock).toHaveBeenCalledWith('a@b.co', 'complained', 'mail-events');
	});

	it('is fail-closed without a key', async () => {
		delete envStub.MAIL_EVENTS_HMAC_KEY;
		const response = await call(signed(JSON.stringify({ email: 'a@b.co', reason: 'bounced' })));
		expect(response.status).toBe(503);
		expect(suppressMock).not.toHaveBeenCalled();
	});

	it('rejects a bad signature', async () => {
		const response = await call(
			signed(JSON.stringify({ email: 'a@b.co', reason: 'bounced' }), {
				signature: `sha256=${'0'.repeat(64)}`
			})
		);
		expect(response.status).toBe(401);
		expect(suppressMock).not.toHaveBeenCalled();
	});

	it('rejects a signature made with the wrong key', async () => {
		const response = await call(
			signed(JSON.stringify({ email: 'a@b.co', reason: 'bounced' }), {
				key: Buffer.alloc(32, 9)
			})
		);
		expect(response.status).toBe(401);
	});

	it('rejects a stale timestamp', async () => {
		const response = await call(
			signed(JSON.stringify({ email: 'a@b.co', reason: 'bounced' }), {
				timestamp: Math.floor(Date.now() / 1000) - 600
			})
		);
		expect(response.status).toBe(401);
	});

	it('rejects an unknown reason and an invalid address', async () => {
		expect(
			(await call(signed(JSON.stringify({ email: 'a@b.co', reason: 'unsubscribed' })))).status
		).toBe(400);
		expect((await call(signed(JSON.stringify({ email: 'nope', reason: 'bounced' })))).status).toBe(
			400
		);
		expect(suppressMock).not.toHaveBeenCalled();
	});
});
