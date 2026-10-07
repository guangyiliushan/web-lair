import { describe, expect, it, vi } from 'vitest';
import { fetchJson, isRateLimitExhausted, ProjectsFetchError, syncUserAgent } from './fetch';

/**
 * T10 (plan §7): the five-class failure surface of the fetch unit - 404 ->
 * not_found; 429 / exhausted-rate-limit 403 -> rate_limited; plain 401/403 ->
 * auth; timeout / persistent 5xx -> network; non-JSON body -> parse. Plus
 * the politeness rules: one in-run retry for 5xx, Retry-After honoured only
 * within the run budget.
 */

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers });

const rejection = (promise: Promise<unknown>) => expect(promise).rejects;

describe('projects fetchJson classification', () => {
	it('maps 404 / 410 to not_found and 401 to auth', async () => {
		const deps = { fetch: vi.fn(async () => jsonResponse(404, {})) as unknown as typeof fetch };
		await rejection(fetchJson('https://api.github.com/x', {}, deps)).toMatchObject({
			name: 'ProjectsFetchError',
			kind: 'not_found'
		});
		const auth = { fetch: vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch };
		await rejection(fetchJson('https://api.github.com/x', {}, auth)).toMatchObject({
			kind: 'auth'
		});
	});

	it('distinguishes an exhausted 403 (rate_limited) from a plain 403 (auth)', async () => {
		const limited = {
			fetch: vi.fn(async () =>
				jsonResponse(403, {}, { 'x-ratelimit-remaining': '0' })
			) as unknown as typeof fetch
		};
		await rejection(fetchJson('https://api.github.com/x', {}, limited)).toMatchObject({
			kind: 'rate_limited'
		});
		const plain = {
			fetch: vi.fn(async () => jsonResponse(403, {})) as unknown as typeof fetch
		};
		await rejection(fetchJson('https://api.github.com/x', {}, plain)).toMatchObject({
			kind: 'auth'
		});
	});

	it('honours a short Retry-After once, then surfaces rate_limited', async () => {
		const doFetch = vi.fn(async () => jsonResponse(429, {}, { 'retry-after': '2' }));
		const sleep = vi.fn(async () => {});
		await rejection(
			fetchJson(
				'https://api.github.com/x',
				{},
				{ fetch: doFetch as unknown as typeof fetch, sleep }
			)
		).toMatchObject({ kind: 'rate_limited' });
		expect(doFetch).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(2000);
	});

	it('gives up immediately when Retry-After exceeds the run budget', async () => {
		const doFetch = vi.fn(async () => jsonResponse(429, {}, { 'retry-after': '600' }));
		const sleep = vi.fn(async () => {});
		await rejection(
			fetchJson(
				'https://api.github.com/x',
				{},
				{ fetch: doFetch as unknown as typeof fetch, sleep }
			)
		).toMatchObject({ kind: 'rate_limited' });
		expect(doFetch).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('retries a 5xx once, then classifies persistent 5xx as network', async () => {
		let calls = 0;
		const flaky = vi.fn(async () => {
			calls += 1;
			return calls === 1 ? jsonResponse(503, {}) : jsonResponse(200, { ok: true });
		});
		const sleep = vi.fn(async () => {});
		const result = await fetchJson(
			'https://api.github.com/x',
			{},
			{ fetch: flaky as unknown as typeof fetch, sleep }
		);
		expect(result.json).toEqual({ ok: true });
		expect(flaky).toHaveBeenCalledTimes(2);

		const broken = vi.fn(async () => jsonResponse(500, {}));
		const sleep2 = vi.fn(async () => {});
		await rejection(
			fetchJson(
				'https://api.github.com/x',
				{},
				{ fetch: broken as unknown as typeof fetch, sleep: sleep2 }
			)
		).toMatchObject({ kind: 'network' });
		expect(broken).toHaveBeenCalledTimes(2);
	});

	it('classifies transport errors (timeout / DNS / TLS) as network', async () => {
		const failing = vi.fn(async () => {
			throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
		});
		await rejection(
			fetchJson('https://api.github.com/x', {}, { fetch: failing as unknown as typeof fetch })
		).toMatchObject({ kind: 'network' });
	});

	it('classifies a non-JSON body as parse', async () => {
		const bad = vi.fn(async () => new Response('not json', { status: 200 }));
		await rejection(
			fetchJson('https://api.github.com/x', {}, { fetch: bad as unknown as typeof fetch })
		).toMatchObject({ kind: 'parse' });
	});
});

describe('projects fetchJson helpers', () => {
	it('reads exhaustion signals per platform', () => {
		expect(
			isRateLimitExhausted('github', new Headers({ 'x-ratelimit-remaining': '0' }))
		).toMatchObject({
			exhausted: true
		});
		expect(
			isRateLimitExhausted('gitlab', new Headers({ 'ratelimit-remaining': '0' }))
		).toMatchObject({
			exhausted: true
		});
		expect(
			isRateLimitExhausted('gitee', new Headers({ 'x-ratelimit-remaining': '1' }))
		).toMatchObject({
			exhausted: false
		});
		// Bitbucket exposes no remaining header on the probed endpoints.
		expect(isRateLimitExhausted('bitbucket', new Headers())).toMatchObject({ exhausted: false });
	});

	it('builds the product UA with an optional contact comment', () => {
		vi.stubEnv('ORIGIN', '');
		expect(syncUserAgent()).toBe('web-lair-projects-sync/0.0.1');
		vi.stubEnv('ORIGIN', 'https://lair.example');
		expect(syncUserAgent()).toBe('web-lair-projects-sync/0.0.1 (+https://lair.example/projects)');
		vi.unstubAllEnvs();
	});

	it('exports a classified error type', () => {
		const error = new ProjectsFetchError('parse', 'boom');
		expect(error.name).toBe('ProjectsFetchError');
		expect(error.kind).toBe('parse');
	});
});
