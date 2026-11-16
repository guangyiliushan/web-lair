import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AI transcription is cost-bearing. The strict account + /64
 * buckets must reject before the audio is read or shipped to whisper.
 */
const mocks = vi.hoisted(() => ({
	rate: vi.fn(async () => ({ allowed: true, count: 1, unavailable: false })),
	transcribe: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/db', () => ({
	db: { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }
}));
vi.mock('$lib/server/db/ai', () => ({ transcripts: {} }));
vi.mock('$lib/server/authz', () => ({ requireAiUse: async () => {} }));
vi.mock('$lib/server/ai/usage', () => ({ recordAiUsage: async () => {} }));
vi.mock('$lib/server/ai/transcribe', () => ({
	transcribeAudio: mocks.transcribe,
	rejectedUpload: () => null
}));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({ rateLimitStrict: mocks.rate }));

import { actions } from './+page.server';

function event() {
	const body = new FormData();
	body.set('audio', new File(['x'], 'a.webm', { type: 'audio/webm' }));
	return {
		request: new Request('http://localhost/admin/ai/transcribe', { method: 'POST', body }),
		locals: { user: { id: 'u1', role: 'owner' } },
		getClientAddress: () => '203.0.113.9',
		setHeaders: vi.fn()
	} as never;
}

const transcribe = actions.transcribe as (event: never) => Promise<{ status?: number }>;

beforeEach(() => {
	mocks.rate.mockClear();
	mocks.transcribe.mockClear();
	mocks.rate.mockResolvedValue({ allowed: true, count: 1, unavailable: false });
});

describe('AI transcribe rate guard', () => {
	it('answers 429 + Retry-After before reading the audio', async () => {
		mocks.rate.mockResolvedValueOnce({ allowed: false, count: 21, unavailable: false });
		const result = await transcribe(event());
		expect(result).toMatchObject({ status: 429, data: { error: 'rate' } });
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.rate).toHaveBeenCalledWith(expect.anything(), 'limits:ai-transcribe:u1', 20, 3600);
	});

	it('fails closed with 503 when the limiter store is offline', async () => {
		mocks.rate.mockResolvedValueOnce({ allowed: false, count: 0, unavailable: true });
		const result = await transcribe(event());
		expect(result).toMatchObject({ status: 503, data: { error: 'unavailable' } });
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});
});
