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

describe('projects fetchJson hardening (review 2026-10-08)', () => {
	it('maps 410 to not_found as well as 404', async () => {
		const gone = { fetch: vi.fn(async () => jsonResponse(410, {})) as unknown as typeof fetch };
		await rejection(fetchJson('https://api.github.com/x', {}, gone)).toMatchObject({
			kind: 'not_found'
		});
	});

	it('retries a timeout once, then succeeds; persistent timeouts end as network', async () => {
		let calls = 0;
		const flaky = vi.fn(async () => {
			calls += 1;
			if (calls === 1) {
				throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
			}
			return jsonResponse(200, { ok: true });
		});
		const sleep = vi.fn(async () => {});
		const result = await fetchJson(
			'https://api.github.com/x',
			{},
			{ fetch: flaky as unknown as typeof fetch, sleep }
		);
		expect(result.json).toEqual({ ok: true });
		expect(flaky).toHaveBeenCalledTimes(2);

		const always = vi.fn(async () => {
			throw new DOMException('aborted', 'TimeoutError');
		});
		await rejection(
			fetchJson('https://api.github.com/x', {}, { fetch: always as unknown as typeof fetch, sleep })
		).toMatchObject({ kind: 'network' });
		expect(always).toHaveBeenCalledTimes(2);
	});

	it('does not retry DNS-style failures', async () => {
		const dns = vi.fn(async () => {
			throw new TypeError('fetch failed');
		});
		const sleep = vi.fn(async () => {});
		await rejection(
			fetchJson('https://api.github.com/x', {}, { fetch: dns as unknown as typeof fetch, sleep })
		).toMatchObject({ kind: 'network' });
		expect(dns).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('follows same-host redirects but rejects cross-origin hops', async () => {
		const urls: string[] = [];
		const same = vi.fn(async (url: RequestInfo | URL) => {
			urls.push(String(url));
			return urls.length === 1
				? new Response(null, {
						status: 301,
						headers: { location: 'https://api.github.com/repos/a/b-new' }
					})
				: jsonResponse(200, { ok: true });
		});
		const result = await fetchJson(
			'https://api.github.com/repos/a/b-old',
			{},
			{ fetch: same as unknown as typeof fetch }
		);
		expect(result.status).toBe(200);
		expect(urls).toEqual([
			'https://api.github.com/repos/a/b-old',
			'https://api.github.com/repos/a/b-new'
		]);

		const cross = vi.fn(
			async () =>
				new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
		);
		await rejection(
			fetchJson('https://api.github.com/x', {}, { fetch: cross as unknown as typeof fetch })
		).toMatchObject({ kind: 'parse' });
		expect(cross).toHaveBeenCalledTimes(1);
	});

	it('treats a bare Retry-After 403 as rate-limited and surfaces the reset time', async () => {
		const limited = {
			fetch: vi.fn(async () =>
				jsonResponse(403, {}, { 'retry-after': '60', 'x-ratelimit-reset': '1700000000' })
			) as unknown as typeof fetch
		};
		const error = (await fetchJson('https://api.github.com/x', {}, limited).catch(
			(caught: unknown) => caught
		)) as ProjectsFetchError;
		expect(error).toMatchObject({ kind: 'rate_limited' });
		expect(error.message).toContain('reset at 2023-11-14');
	});

	it('parses the HTTP-date form of Retry-After', async () => {
		let calls = 0;
		const flaky = vi.fn(async () => {
			calls += 1;
			return calls === 1
				? jsonResponse(429, {}, { 'retry-after': new Date(Date.now() + 1500).toUTCString() })
				: jsonResponse(200, { ok: true });
		});
		const sleep = vi.fn(async () => {});
		const result = await fetchJson(
			'https://api.github.com/x',
			{},
			{ fetch: flaky as unknown as typeof fetch, sleep }
		);
		expect(result.json).toEqual({ ok: true });
		expect(flaky).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
	});
});
