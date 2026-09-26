import { describe, expect, it, vi } from 'vitest';
import {
	parseModelsText,
	parseProviderForm,
	providerFieldErrors,
	providerInputSchema,
	testProviderConnection
} from './ai-providers';

function form(fields: Record<string, string>): FormData {
	const fd = new FormData();
	for (const [key, value] of Object.entries(fields)) fd.set(key, value);
	return fd;
}

describe('provider input schema', () => {
	it('accepts a minimal valid form and maps empties to null', () => {
		const parsed = providerInputSchema.parse({
			name: ' OpenAI ',
			kind: 'openai-compatible',
			baseUrl: '',
			apiKeyEnv: '',
			modelsText: '',
			enabled: true
		});
		expect(parsed).toEqual({
			name: 'OpenAI',
			kind: 'openai-compatible',
			baseUrl: null,
			apiKeyEnv: null,
			models: null,
			enabled: true
		});
	});

	it('rejects a bad env name and a bad URL with per-field messages', () => {
		const bad = providerInputSchema.safeParse({
			name: 'x',
			kind: 'custom',
			baseUrl: 'not a url',
			apiKeyEnv: 'lowercase_name',
			modelsText: '',
			enabled: true
		});
		expect(bad.success).toBe(false);
		if (bad.success) throw new Error('unreachable');
		const errors = providerFieldErrors(bad.error);
		expect(errors.baseUrl).toBeTruthy();
		expect(errors.apiKeyEnv).toBeTruthy();
	});

	it('parses the models textarea (lines, commas, dedupe)', () => {
		expect(parseModelsText(' a\nb, a \n\n')).toEqual(['a', 'b']);
		expect(parseModelsText('   ')).toBeNull();
	});

	it('reads the checkbox convention of the provider form', () => {
		expect(parseProviderForm(form({ name: 'x', enabled: 'on' }))).toMatchObject({
			enabled: true,
			kind: 'openai-compatible'
		});
		expect(parseProviderForm(form({ name: 'x' }))).toMatchObject({ enabled: false });
	});
});

describe('testProviderConnection', () => {
	const noKey = () => undefined;

	it('reports a missing env value before any fetch', async () => {
		const fetchImpl = vi.fn();
		const result = await testProviderConnection(
			{ kind: 'openai-compatible', baseUrl: null, apiKeyEnv: 'OPENAI_API_KEY' },
			noKey,
			fetchImpl as never
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('OPENAI_API_KEY');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('calls /models with a bearer token for openai-compatible', async () => {
		const seen: { url: string; init?: RequestInit }[] = [];
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			seen.push({ url, init });
			return new Response('{}', { status: 200 });
		});
		const result = await testProviderConnection(
			{ kind: 'openai-compatible', baseUrl: 'https://x.test/v1/', apiKeyEnv: 'K' },
			() => 'sk-1',
			fetchImpl as never
		);
		expect(result.ok).toBe(true);
		expect(seen[0].url).toBe('https://x.test/v1/models');
		expect(seen[0].init?.headers).toMatchObject({ authorization: 'Bearer sk-1' });
	});

	it('reports the HTTP status and hits /usage for deepl', async () => {
		const seen: { url: string; init?: RequestInit }[] = [];
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			seen.push({ url, init });
			return new Response('nope', { status: 401 });
		});
		const result = await testProviderConnection(
			{ kind: 'deepl', baseUrl: null, apiKeyEnv: 'DEEPL_KEY' },
			() => 'k',
			fetchImpl as never
		);
		expect(result).toEqual({ ok: false, message: 'HTTP 401' });
		expect(seen[0].url).toBe('https://api.deepl.com/v2/usage');
	});

	it('requires a base URL for custom providers and tolerates no key', async () => {
		const missing = await testProviderConnection(
			{ kind: 'custom', baseUrl: null, apiKeyEnv: null },
			noKey,
			vi.fn() as never
		);
		expect(missing).toEqual({ ok: false, message: '自定义服务商需要填写 Base URL' });

		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const ok = await testProviderConnection(
			{ kind: 'custom', baseUrl: 'https://gw.test', apiKeyEnv: null },
			noKey,
			fetchImpl as never
		);
		expect(ok.ok).toBe(true);
	});

	it('turns network errors and timeouts into readable results', async () => {
		const failing = vi.fn(async () => {
			throw new Error('fetch failed');
		});
		const failed = await testProviderConnection(
			{ kind: 'custom', baseUrl: 'https://gw.test', apiKeyEnv: null },
			noKey,
			failing as never
		);
		expect(failed.message).toContain('连接失败');

		const timeout = vi.fn(async () => {
			const error = new Error('timed out');
			error.name = 'TimeoutError';
			throw error;
		});
		const timedOut = await testProviderConnection(
			{ kind: 'custom', baseUrl: 'https://gw.test', apiKeyEnv: null },
			noKey,
			timeout as never
		);
		expect(timedOut.message).toContain('超时');
	});
});
