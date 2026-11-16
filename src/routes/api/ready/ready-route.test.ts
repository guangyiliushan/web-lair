import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	execute: vi.fn(async (): Promise<unknown> => [{ ok: 1 }]),
	ping: vi.fn(async (): Promise<void> => {})
}));

vi.mock('$env/dynamic/private', () => ({ env: state.env }));
vi.mock('$lib/server/db', () => ({ db: { execute: state.execute } }));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({ ping: state.ping }) }));

import { resetReadyProbe } from '$lib/server/health/ready';
import { GET } from './+server';

function event(address: string | null, authorization?: string): never {
	const headers = new Headers();
	if (authorization) headers.set('authorization', authorization);
	return {
		request: new Request('http://localhost/api/ready', { headers }),
		getClientAddress: () => {
			if (address === null) throw new Error('no client address');
			return address;
		}
	} as never;
}

async function body(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
	for (const key of Object.keys(state.env)) delete state.env[key];
	state.execute.mockReset();
	state.execute.mockResolvedValue([{ ok: 1 }]);
	state.ping.mockReset();
	state.ping.mockResolvedValue(undefined);
	resetReadyProbe();
});

describe('GET /api/ready', () => {
	it('answers 404 to a public caller when no token is configured', async () => {
		const response = await GET(event('203.0.113.7'));
		expect(response.status).toBe(404);
		expect(state.execute).not.toHaveBeenCalled();
	});

	it('answers 404 to a caller whose address cannot be resolved', async () => {
		const response = await GET(event(null));
		expect(response.status).toBe(404);
	});

	it('answers 401 to a public caller missing the bearer when a token is set', async () => {
		state.env.READY_TOKEN = 'probe-token';
		const response = await GET(event('203.0.113.7'));
		expect(response.status).toBe(401);
		expect(await body(response)).toEqual({ status: 'unauthorized' });
		expect(state.execute).not.toHaveBeenCalled();
	});

	it('answers 401 to a public caller with the wrong bearer', async () => {
		state.env.READY_TOKEN = 'probe-token';
		const response = await GET(event('203.0.113.7', 'Bearer nope'));
		expect(response.status).toBe(401);
	});

	it('requires the bearer even from a private peer when a token is set', async () => {
		state.env.READY_TOKEN = 'probe-token';
		const response = await GET(event('172.17.0.2'));
		expect(response.status).toBe(401);
		expect(state.execute).not.toHaveBeenCalled();
	});

	it('lets a valid bearer through from a public address', async () => {
		state.env.READY_TOKEN = 'probe-token';
		const response = await GET(event('203.0.113.7', 'Bearer probe-token'));
		expect(response.status).toBe(200);
		expect(await body(response)).toMatchObject({
			status: 'ready',
			db: 'ok',
			valkey: 'disabled',
			cached: false
		});
	});

	it('lets private and loopback peers through without a token', async () => {
		for (const address of ['127.0.0.1', '::1', '172.17.0.2', '192.168.1.5', 'fd00::7']) {
			resetReadyProbe();
			const response = await GET(event(address));
			expect(response.status).toBe(200);
		}
	});

	it('fails closed in production when no token is configured', async () => {
		state.env.NODE_ENV = 'production';
		const response = await GET(event('127.0.0.1'));
		expect(response.status).toBe(404);
		expect(state.execute).not.toHaveBeenCalled();
	});

	it('serves a valid bearer in production (token branch takes precedence)', async () => {
		state.env.READY_TOKEN = 'probe-token';
		state.env.NODE_ENV = 'production';
		const response = await GET(event('203.0.113.7', 'Bearer probe-token'));
		expect(response.status).toBe(200);
		expect(await body(response)).toMatchObject({ status: 'ready' });
	});

	it('reports per-check detail with 503 when the database is down', async () => {
		state.execute.mockRejectedValue(new Error('ECONNREFUSED'));
		const response = await GET(event('127.0.0.1'));
		expect(response.status).toBe(503);
		expect(await body(response)).toMatchObject({
			status: 'not_ready',
			db: 'fail',
			valkey: 'disabled'
		});
	});

	it('probes Valkey when VALKEY_URL is configured', async () => {
		state.env.VALKEY_URL = 'redis://127.0.0.1:6379';
		const response = await GET(event('127.0.0.1'));
		expect(response.status).toBe(200);
		expect(await body(response)).toMatchObject({ status: 'ready', valkey: 'ok' });
		expect(state.ping).toHaveBeenCalledTimes(1);
	});

	it('reports a Valkey failure with 503', async () => {
		state.env.VALKEY_URL = 'redis://127.0.0.1:6379';
		state.ping.mockRejectedValue(new Error('ECONNREFUSED'));
		const response = await GET(event('127.0.0.1'));
		expect(response.status).toBe(503);
		expect(await body(response)).toMatchObject({ status: 'not_ready', valkey: 'fail' });
	});

	it('caches the verdict for 10s (one DB round trip per window)', async () => {
		const first = await GET(event('127.0.0.1'));
		const second = await GET(event('127.0.0.1'));
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await body(second)).toMatchObject({ cached: true });
		expect(state.execute).toHaveBeenCalledTimes(1);
	});

	it('never caches the auth decision away', async () => {
		state.env.READY_TOKEN = 'probe-token';
		expect((await GET(event('203.0.113.7'))).status).toBe(401);
		expect((await GET(event('203.0.113.7', 'Bearer probe-token'))).status).toBe(200);
	});

	it('sends no-store cache headers', async () => {
		const response = await GET(event('127.0.0.1'));
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('content-type')).toContain('application/json');
	});
});
