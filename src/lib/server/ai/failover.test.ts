import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Failover is the whole point of aggregation, and it is the part that is easiest
 * to get subtly wrong: which failures move on, how many ledger rows a chain
 * writes, and whether the budget gate can be bypassed by a second member.
 */

const mocks = vi.hoisted(() => ({
	chain: [] as {
		provider: {
			id: string;
			name: string;
			kind: 'openai-compatible';
			baseUrl: string;
			apiKeyEnv: string | null;
			models: string[];
			enabled: boolean;
		};
		model: string;
		primaryModel: string;
	}[],
	recordUsage: vi.fn<(db: unknown, record: Record<string, unknown>) => Promise<void>>(
		async () => undefined
	),
	recordAlerts: vi.fn(async () => undefined),
	assertBudget: vi.fn(async () => ({
		monthly: 0,
		currency: 'USD',
		alertRatios: [],
		pauseAutoOnExceed: false,
		spent: 0,
		unpricedCalls: 0,
		paused: false
	}))
}));

function candidate(name: string) {
	return {
		provider: {
			id: name,
			name,
			kind: 'openai-compatible' as const,
			baseUrl: `https://${name}.example/v1`,
			apiKeyEnv: null,
			models: ['m'],
			enabled: true
		},
		model: 'm',
		primaryModel: 'm'
	};
}

vi.mock('./providers.ts', () => ({
	resolveProviderChain: async () => mocks.chain,
	resolveProvider: async () => {
		const [first] = mocks.chain;
		return { provider: first.provider, model: first.model, assignment: {} };
	},
	defaultBaseUrl: () => 'https://api.example/v1',
	providerUrl: (provider: { baseUrl: string }) => `${provider.baseUrl}/chat/completions`
}));
vi.mock('./budget.ts', () => ({
	assertBudget: mocks.assertBudget,
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
vi.mock('./usage.ts', () => ({ recordAiUsage: mocks.recordUsage }));
vi.mock('../security/ssrf-guard', () => ({
	isPrivateHost: () => false,
	resolvePublicAddresses: async () => [{ address: '93.184.216.34', family: 4 }]
}));
vi.mock('../config/options-registry', () => ({
	getOption: async (key: string) =>
		key === 'ai.pricing' ? { 'b/m': { inputPer1M: 1, outputPer1M: 1 } } : {}
}));

const { runAiCall } = await import('./client');

function ok(text = 'hello') {
	return new Response(
		JSON.stringify({
			choices: [{ message: { content: text }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 10, completion_tokens: 5 }
		}),
		{ status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req' } }
	);
}

function error(status: number, message = 'nope') {
	return new Response(JSON.stringify({ error: { message } }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const deps = {
	db: {} as never,
	getEnv: () => 'secret',
	sleep: async () => undefined
};

const input = {
	task: 'translation' as const,
	functionSlot: 'translation' as const,
	system: 's',
	user: 'u'
};

beforeEach(() => {
	mocks.recordUsage.mockClear();
	mocks.recordAlerts.mockClear();
	mocks.assertBudget.mockClear();
	mocks.chain = [candidate('a'), candidate('b')];
});

describe('runAiCall failover', () => {
	it('moves to the next member on a rate limit and records both attempts', async () => {
		const fetchImpl = vi.fn(async (url: string) =>
			url.startsWith('https://a.') ? error(429) : ok()
		);
		const result = await runAiCall(input, { ...deps, fetch: fetchImpl as never, maxAttempts: 1 });
		expect(result.text).toBe('hello');
		expect(result.provider).toBe('b');
		expect(result.requestedModel).toBe('m');
		// A fallback to another model reports where the chain started.
		// Two real attempts -> two rows, the first one a failure.
		expect(mocks.recordUsage).toHaveBeenCalledTimes(2);
		expect(mocks.recordUsage.mock.calls[0][1]).toMatchObject({
			provider: 'a',
			status: 'failure',
			requestedModel: 'm'
		});
		expect(mocks.recordUsage.mock.calls[1][1]).toMatchObject({
			provider: 'b',
			status: 'success',
			requestedModel: 'm'
		});
	});

	it('does not fail over a request-shaped failure', async () => {
		// A 400 is this request's fault: trying it on a second provider would
		// spend money twice and hide the real bug.
		const fetchImpl = vi.fn(async () => error(400, 'bad request'));
		await expect(
			runAiCall(input, { ...deps, fetch: fetchImpl as never, maxAttempts: 1 })
		).rejects.toMatchObject({ code: 'bad_request' });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
	});

	it('fails over an exhausted quota without retrying the same provider', async () => {
		// 456 is DeepL's "quota exhausted"; it maps to `quota`, which is not
		// retryable locally but IS worth another provider.
		const fetchImpl = vi.fn(async (url: string) =>
			url.startsWith('https://a.') ? error(456, 'quota exhausted') : ok()
		);
		const result = await runAiCall(input, { ...deps, fetch: fetchImpl as never });
		expect(result.provider).toBe('b');
		// One attempt on `a` (quota is not retryable), one on `b`.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('throws the LAST error when every member fails', async () => {
		const fetchImpl = vi.fn(async (url: string) =>
			url.startsWith('https://a.') ? error(429) : error(503)
		);
		await expect(
			runAiCall(input, { ...deps, fetch: fetchImpl as never, maxAttempts: 1 })
		).rejects.toMatchObject({ code: 'network' });
		expect(mocks.recordUsage).toHaveBeenCalledTimes(2);
	});

	it('checks the budget once, not once per member', async () => {
		const fetchImpl = vi.fn(async () => ok());
		await runAiCall(input, { ...deps, fetch: fetchImpl as never });
		expect(mocks.assertBudget).toHaveBeenCalledTimes(1);
	});

	it('never reaches a provider when the budget refuses the call', async () => {
		const { AiError } = await import('./errors.ts');
		mocks.assertBudget.mockRejectedValueOnce(new AiError('budget', 'over budget'));
		const fetchImpl = vi.fn(async () => ok());
		await expect(runAiCall(input, { ...deps, fetch: fetchImpl as never })).rejects.toMatchObject({
			code: 'budget'
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		// A refusal is still attributed to the primary member so the ledger shows
		// what the blocked call would have used.
		expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
		expect(mocks.recordUsage.mock.calls[0][1]).toMatchObject({
			provider: 'a',
			status: 'failure',
			requestedModel: 'm'
		});
	});

	it('keeps a single-provider call unchanged', async () => {
		mocks.chain = [{ ...candidate('a'), primaryModel: 'm' }];
		const fetchImpl = vi.fn(async () => ok());
		const result = await runAiCall(input, { ...deps, fetch: fetchImpl as never });
		expect(result.requestedModel).toBe('m');
		expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
		expect(mocks.recordUsage.mock.calls[0][1]).toMatchObject({ requestedModel: 'm' });
	});

	it('switches MODEL when every provider of the assigned one is rate limited', async () => {
		// The chain the pool builds: the assigned model on both gateways first,
		// then the pool's next model. A 429 on both is exactly the "this model is
		// throttled right now" case, and it must reach the next model.
		mocks.chain = [
			{ ...candidate('a'), model: 'flash', primaryModel: 'flash' },
			{ ...candidate('b'), model: 'flash', primaryModel: 'flash' },
			{ ...candidate('c'), model: 'pro', primaryModel: 'flash' }
		];
		const fetchImpl = vi.fn(async (url: string) =>
			// Providers a and b both serve `flash`; c is the next model.
			url.startsWith('https://a.') || url.startsWith('https://b.') ? error(429) : ok('from pro')
		);
		// `maxAttempts: 1` so the test sees the failover, not the local retries.
		const result = await runAiCall(input, { ...deps, fetch: fetchImpl as never, maxAttempts: 1 });
		expect(result.provider).toBe('c');
		expect(result.model).toBe('pro');
		// The slot still asked for `flash`: that difference is how the ledger
		// records "we left the preferred model".
		expect(result.requestedModel).toBe('flash');
		expect(mocks.recordUsage).toHaveBeenCalledTimes(3);
		expect(mocks.recordUsage.mock.calls.map((call) => call[1].status)).toEqual([
			'failure',
			'failure',
			'success'
		]);
		expect(mocks.recordUsage.mock.calls[2][1]).toMatchObject({
			model: 'pro',
			requestedModel: 'flash'
		});
	});

	it('also switches model on a quota-exhausted provider', async () => {
		mocks.chain = [
			{ ...candidate('a'), model: 'flash', primaryModel: 'flash' },
			{ ...candidate('b'), model: 'pro', primaryModel: 'flash' }
		];
		const fetchImpl = vi.fn(async (url: string) =>
			url.startsWith('https://a.') ? error(456) : ok('from pro')
		);
		const result = await runAiCall(input, { ...deps, fetch: fetchImpl as never });
		expect(result.model).toBe('pro');
	});
});
