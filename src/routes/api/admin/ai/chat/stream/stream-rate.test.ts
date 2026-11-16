import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The AI chat stream is a cost-bearing security endpoint. The strict account +
 * /64 buckets must reject before any conversation/provider work, with 429/503
 * and Retry-After.
 */
const mocks = vi.hoisted(() => ({
	rate: vi.fn(async () => ({ allowed: true, count: 1, unavailable: false })),
	stream: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/db', () => ({
	db: {
		select: () => {
			throw new Error('db must not be touched on the denied path');
		}
	}
}));
vi.mock('$lib/server/db/ai', () => ({ aiAgentConversations: {}, aiAgentMessages: {} }));
vi.mock('$lib/server/authz', () => ({
	requireAiUse: async () => {},
	adminContextFor: () => ({ userId: 'u1', role: 'owner' })
}));
vi.mock('$lib/server/audit', () => ({ recordActivity: async () => {} }));
vi.mock('$lib/server/ai/agent/run', () => ({ streamAgentChat: mocks.stream }));
vi.mock('$lib/server/ai/chat-error', () => ({ chatErrorMessage: () => 'error' }));
vi.mock('$lib/server/secrets/resolver', () => ({ resolveProviderKey: async () => 'key' }));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({ rateLimitStrict: mocks.rate }));

import { POST } from './+server';

function event() {
	return {
		request: new Request('http://localhost/api/admin/ai/chat/stream', {
			method: 'POST',
			body: JSON.stringify({ conversationId: 'c1', text: 'hi' }),
			headers: { 'content-type': 'application/json' }
		}),
		locals: { user: { id: 'u1', role: 'owner' }, admin: { userId: 'u1', role: 'owner' } },
		getClientAddress: () => '203.0.113.9'
	} as never;
}

beforeEach(() => {
	mocks.rate.mockClear();
	mocks.stream.mockClear();
	mocks.rate.mockResolvedValue({ allowed: true, count: 1, unavailable: false });
});

describe('AI chat stream rate guard', () => {
	it('answers 429 + Retry-After before reading the conversation', async () => {
		mocks.rate.mockResolvedValueOnce({ allowed: false, count: 31, unavailable: false });
		const response = await POST(event());
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('3600');
		expect(await response.text()).toBe('throttled');
		expect(mocks.stream).not.toHaveBeenCalled();
		expect(mocks.rate).toHaveBeenCalledWith(expect.anything(), 'limits:ai-chat:u1', 30, 3600);
	});

	it('fails closed with 503 when the limiter store is offline', async () => {
		mocks.rate.mockResolvedValueOnce({ allowed: false, count: 0, unavailable: true });
		const response = await POST(event());
		expect(response.status).toBe(503);
		expect(await response.text()).toBe('unavailable');
		expect(mocks.stream).not.toHaveBeenCalled();
	});
});
