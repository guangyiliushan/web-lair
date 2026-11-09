import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	recordUsage: vi.fn(async () => undefined),
	recordAlerts: vi.fn(async () => undefined),
	provider: {
		id: 'p1',
		name: 'p',
		kind: 'openai-compatible' as const,
		baseUrl: 'https://api.example/v1',
		apiKeyEnv: 'AI_KEY',
		models: ['m'],
		enabled: true
	}
}));

vi.mock('./providers', () => ({
	resolveProviderChain: async () => [{ provider: mocks.provider, model: 'm', group: null }],
	resolveProvider: async () => ({ provider: mocks.provider, model: 'm', assignment: {} }),
	defaultBaseUrl: () => 'https://api.example/v1',
	providerUrl: () => 'https://api.example/v1/chat/completions'
}));
vi.mock('./budget', () => ({
	assertBudget: async () => ({
		monthly: 0,
		currency: 'USD',
		alertRatios: [],
		pauseAutoOnExceed: false,
		spent: 0,
		unpricedCalls: 0,
		paused: false
	}),
	readBudgetState: async () => ({
		monthly: 0,
		currency: 'USD',
		alertRatios: [],
		pauseAutoOnExceed: false,
		spent: 0,
		unpricedCalls: 0,
		paused: false
	}),
	recordBudgetAlerts: mocks.recordAlerts
}));
vi.mock('./usage', () => ({ recordAiUsage: mocks.recordUsage }));
// The SSRF guard does real DNS lookups; the fixtures use a fake host, so the
// guard is stubbed here (its own behavior is covered by ssrf-guard.test.ts).
const ssrfMocks = vi.hoisted(() => ({
	isPrivateHost: vi.fn(() => false),
	resolvePublicAddresses: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
}));
vi.mock('../security/ssrf-guard', () => ({
	isPrivateHost: ssrfMocks.isPrivateHost,
	resolvePublicAddresses: ssrfMocks.resolvePublicAddresses
}));
vi.mock('../config/options-registry', () => ({
	getOption: async (key: string) =>
		key === 'ai.pricing' ? { 'p/m': { inputPer1M: 1, outputPer1M: 2 } } : {}
}));

const { runAiCall } = await import('./client');

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'x-request-id': 'req-1', ...headers }
	});
}

/** An SSE completion whose chunks arrive as the reader asks for them. */
function streamResponse(chunks: string[]) {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-1' } }
	);
}

function sse(content: string, extra: Record<string, unknown> = {}): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }], ...extra })}\n\n`;
}

const baseDeps = {
	db: {} as never,
	getEnv: (name: string) => (name === 'AI_KEY' ? 'secret' : undefined),
	sleep: async () => undefined
};

beforeEach(() => {
	mocks.recordUsage.mockClear();
	mocks.recordAlerts.mockClear();
	ssrfMocks.isPrivateHost.mockReset();
	ssrfMocks.isPrivateHost.mockReturnValue(false);
	ssrfMocks.resolvePublicAddresses.mockClear();
});

const input = {
	task: 'summary' as const,
	functionSlot: 'summary' as const,
	system: 'system',
	user: 'user'
};

describe('AI runtime', () => {
	it('returns text, usage and a computed cost', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				choices: [{ message: { content: 'hello' } }],
				usage: { prompt_tokens: 100, completion_tokens: 50 }
			})
		);
		const result = await runAiCall(input, { ...baseDeps, fetch: fetchImpl as never });
		expect(result.text).toBe('hello');
		expect(result.inputTokens).toBe(100);
		expect(result.outputTokens).toBe(50);
		expect(result.costEstimate).toBeCloseTo(0.0002, 6);
		expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
	});

	it('retries a 429 and then succeeds', async () => {
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			if (calls === 1) return jsonResponse({ error: { message: 'rate' } }, 429);
			return jsonResponse({ choices: [{ message: { content: 'ok' } }], usage: {} });
		});
		const result = await runAiCall(input, { ...baseDeps, fetch: fetchImpl as never });
		expect(result.text).toBe('ok');
		expect(calls).toBe(2);
	});

	it('does not retry auth failures and writes a failure row', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 401));
		await expect(
			runAiCall(input, { ...baseDeps, fetch: fetchImpl as never })
		).rejects.toMatchObject({
			code: 'auth'
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(mocks.recordUsage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ status: 'failure' })
		);
	});

	it('refuses a custom base URL that fails the public-resolution check', async () => {
		// The guard must stop the call before fetch: no provider request, no
		// key leaked to a non-public host. A fresh base URL is required: the
		// guard caches per-URL results across tests.
		mocks.provider.baseUrl = 'https://blocked.example/v1';
		ssrfMocks.isPrivateHost.mockReturnValue(true);
		const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'x' } }] }));
		try {
			await expect(
				runAiCall(input, { ...baseDeps, fetch: fetchImpl as never })
			).rejects.toMatchObject({ code: 'bad_request' });
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			mocks.provider.baseUrl = 'https://api.example/v1';
		}
	});

	it('sends thinking:disabled only for a DeepSeek host when the caller opts out', async () => {
		// A holder object keeps TypeScript from narrowing the captured body to
		// `null` at the assertion site (the assignment happens in a callback).
		const captured: { body: Record<string, unknown> | null } = { body: null };
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
			return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
		});

		// A non-DeepSeek gateway never receives the provider extension.
		await runAiCall({ ...input, thinking: 'off' }, { ...baseDeps, fetch: fetchImpl as never });
		expect(captured.body?.thinking).toBeUndefined();

		mocks.provider.baseUrl = 'https://api.deepseek.com/v1';
		try {
			await runAiCall({ ...input, thinking: 'off' }, { ...baseDeps, fetch: fetchImpl as never });
			expect(captured.body?.thinking).toEqual({ type: 'disabled' });
		} finally {
			mocks.provider.baseUrl = 'https://api.example/v1';
		}
	});

	it('rejects an answer the provider truncated at max_tokens', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ choices: [{ message: { content: 'half' }, finish_reason: 'length' }] })
		);
		await expect(
			runAiCall(input, { ...baseDeps, fetch: fetchImpl as never })
		).rejects.toMatchObject({ code: 'invalid_output' });
	});

	it('streams the body to onProgress and keeps the final usage', async () => {
		const captured: { body: Record<string, unknown> | null } = { body: null };
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
			return streamResponse([
				sse('Hello'),
				sse(' world'),
				`data: ${JSON.stringify({
					choices: [{ delta: {}, finish_reason: 'stop' }],
					usage: { prompt_tokens: 10, completion_tokens: 4 }
				})}\n\n`,
				'data: [DONE]\n\n'
			]);
		});
		const seen: string[] = [];

		const result = await runAiCall(
			{ ...input, onProgress: (text) => seen.push(text) },
			{ ...baseDeps, fetch: fetchImpl as never }
		);

		expect(captured.body?.stream).toBe(true);
		expect(captured.body?.stream_options).toEqual({ include_usage: true });
		// Every callback carries the whole text so far, so a replayed frame or a
		// retry can overwrite the preview instead of appending twice.
		expect(seen).toEqual(['Hello', 'Hello world']);
		expect(result.text).toBe('Hello world');
		expect(result.inputTokens).toBe(10);
		expect(result.outputTokens).toBe(4);
	});

	it('does not ask for a stream when the caller wants no progress', async () => {
		const captured: { body: Record<string, unknown> | null } = { body: null };
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
			return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
		});

		await runAiCall(input, { ...baseDeps, fetch: fetchImpl as never });

		expect(captured.body?.stream).toBeUndefined();
		expect(captured.body?.stream_options).toBeUndefined();
	});

	it('rejects a stream cut at max_tokens even though text arrived', async () => {
		const fetchImpl = vi.fn(async () =>
			streamResponse([
				sse('half'),
				`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`
			])
		);
		await expect(
			runAiCall({ ...input, onProgress: () => {} }, { ...baseDeps, fetch: fetchImpl as never })
		).rejects.toMatchObject({ code: 'invalid_output' });
	});

	it('aborts a stream that stops producing chunks', async () => {
		// The whole-call cap is minutes; a provider that hangs mid-body must
		// fail in seconds. The mock stream errors when its request signal
		// aborts, which is what a real fetch body does.
		let aborted = false;
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			const signal = init.signal as AbortSignal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(sse('hi')));
					signal.addEventListener('abort', () => {
						aborted = true;
						controller.error(new Error('aborted'));
					});
				}
			});
			return new Response(body, {
				status: 200,
				headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-1' }
			});
		});

		await expect(
			runAiCall(
				{ ...input, onProgress: () => undefined },
				{ ...baseDeps, streamIdleMs: 20, maxAttempts: 1, fetch: fetchImpl as never }
			)
		).rejects.toMatchObject({ code: 'timeout' });
		expect(aborted).toBe(true);
	});
});
