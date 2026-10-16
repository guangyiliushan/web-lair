import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests for the presence heartbeat endpoint (realtime R2, ledger §23):
 * the JSON-only gate (415), the strict payload guards (400, checked BEFORE
 * the limiter so a junk token never spends a bucket), the per-token
 * fail-open rate bucket (429 + X-Retry-After) and the 204 contract with the
 * exact service arguments. The presence service and the limiter are mocked;
 * the constants the endpoint welds (bucket count) come from the real module.
 */
const { state, rateLimitMock, touchMock } = vi.hoisted(() => {
	const state = {
		store: { tag: 'store' },
		rate: { allowed: true, count: 1 },
		rateCalls: [] as unknown[][],
		touches: [] as { input: unknown; deps: unknown }[]
	};
	const rateLimitMock = vi.fn(async (...args: unknown[]) => {
		state.rateCalls.push(args);
		return state.rate;
	});
	const touchMock = vi.fn(async (input: unknown, deps: unknown) => {
		state.touches.push({ input, deps });
	});
	return { state, rateLimitMock, touchMock };
});

vi.mock('$lib/server/cache', () => ({ getCache: () => state.store }));
vi.mock('$lib/server/cache/store', () => ({ rateLimit: rateLimitMock }));
vi.mock('$lib/server/services/presence', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/services/presence')>();
	return { ...actual, touchPresence: touchMock };
});

import { POST, presenceHeartbeatLimitKey } from './+server';

const TOKEN = '6f3a2b9c-0d4e-4c8a-9b1f-2f9c4d7e8a11';
const CONTENT = '0d9e4b2a-7c31-4f5e-8a6b-1c2d3e4f5a6b';

async function post(
	body: BodyInit,
	contentType: string | null = 'application/json'
): Promise<Response> {
	const headers = contentType === null ? undefined : { 'content-type': contentType };
	return POST({
		request: new Request('http://localhost/api/presence/heartbeat', {
			method: 'POST',
			headers,
			body
		})
	} as never);
}

describe('presence heartbeat route', () => {
	beforeEach(() => {
		state.rate = { allowed: true, count: 1 };
		state.rateCalls = [];
		state.touches = [];
	});

	it('answers 415 for non-JSON or missing content types', async () => {
		expect((await post('token=1', 'application/x-www-form-urlencoded')).status).toBe(415);
		// String bodies auto-label as text/plain; an unlabeled binary body
		// must fail the same gate.
		expect((await post(new Uint8Array([1]), null)).status).toBe(415);
		expect(state.rateCalls).toHaveLength(0);
		expect(state.touches).toHaveLength(0);
	});

	it('answers 400 for malformed or out-of-shape payloads', async () => {
		const badBodies: unknown[] = [
			'{ not json',
			{},
			{ token: 'not-a-uuid' },
			{ token: TOKEN, c: 'doc' },
			{ token: TOKEN, c: CONTENT, bucket: 20 },
			{ token: TOKEN, c: CONTENT, bucket: -1 },
			{ token: TOKEN, c: CONTENT, bucket: 1.5 },
			{ token: TOKEN, bucket: 3 } // bucket without a content id
		];
		for (const body of badBodies) {
			const response = await post(typeof body === 'string' ? body : JSON.stringify(body));
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
		expect(state.rateCalls).toHaveLength(0);
		expect(state.touches).toHaveLength(0);
	});

	it('answers 429 with X-Retry-After once the per-token window is spent', async () => {
		state.rate = { allowed: false, count: 16 };
		const response = await post(JSON.stringify({ token: TOKEN }));
		expect(response.status).toBe(429);
		expect(response.headers.get('x-retry-after')).toBe('60');
		expect(state.rateCalls).toEqual([[state.store, presenceHeartbeatLimitKey(TOKEN), 15, 60]]);
		expect(state.touches).toHaveLength(0);
	});

	it('validates before the limiter (a junk token never reaches a bucket)', async () => {
		state.rate = { allowed: false, count: 16 };
		const response = await post(JSON.stringify({ token: 'junk' }));
		expect(response.status).toBe(400);
		expect(state.rateCalls).toHaveLength(0);
	});

	it('records a content heartbeat and answers 204', async () => {
		const response = await post(JSON.stringify({ token: TOKEN, c: CONTENT, bucket: 7 }));
		expect(response.status).toBe(204);
		expect(state.touches).toEqual([
			{
				input: { token: TOKEN, contentId: CONTENT, bucket: 7 },
				deps: { store: state.store }
			}
		]);
		expect(state.rateCalls).toEqual([[state.store, presenceHeartbeatLimitKey(TOKEN), 15, 60]]);
	});

	it('records a site beat without content fields', async () => {
		const response = await post(JSON.stringify({ token: TOKEN }));
		expect(response.status).toBe(204);
		expect(state.touches).toEqual([{ input: { token: TOKEN }, deps: { store: state.store } }]);
	});

	it('accepts a charset suffix on the JSON content type', async () => {
		const response = await post(
			JSON.stringify({ token: TOKEN }),
			'application/json; charset=utf-8'
		);
		expect(response.status).toBe(204);
	});
});
