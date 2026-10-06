import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	buildUserAgent,
	fetchUnit,
	LinkFetchError,
	type FetchUnitDeps,
	type FetchUnitOptions
} from './fetch';

const OPTS: FetchUnitOptions = {
	userAgent: 'web-lair-link-check/0.0.1',
	timeoutMs: 5_000,
	maxBytes: 1024,
	wantBody: true
};

const RESOLVED = [{ address: '93.184.216.34', family: 4 }];

function depsWith(fetchImpl: unknown, resolveHost?: FetchUnitDeps['resolveHost']): FetchUnitDeps {
	return {
		fetch: fetchImpl as FetchUnitDeps['fetch'],
		resolveHost: resolveHost ?? (async () => RESOLVED)
	};
}

describe('fetchUnit (§4.2/§4.8)', () => {
	it('rejects non-https targets before any resolution', async () => {
		const resolveHost = vi.fn(async () => RESOLVED);
		await expect(
			fetchUnit('http://x.example/', OPTS, depsWith(vi.fn(), resolveHost))
		).rejects.toMatchObject({ code: 'non-https' });
		expect(resolveHost).not.toHaveBeenCalled();
	});

	it('rejects unparsable URLs', async () => {
		await expect(fetchUnit('not a url', OPTS, depsWith(vi.fn()))).rejects.toMatchObject({
			code: 'bad-url'
		});
	});

	it('refuses hosts whose resolved set contains no public address (ssrf)', async () => {
		await expect(
			fetchUnit(
				'https://intranet.example/',
				OPTS,
				depsWith(vi.fn(), async () => null)
			)
		).rejects.toMatchObject({ code: 'ssrf' });
	});

	it('propagates resolver failures (classified as site state upstream)', async () => {
		const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND dead.invalid'), {
			code: 'ENOTFOUND'
		});
		await expect(
			fetchUnit(
				'https://dead.invalid/',
				OPTS,
				depsWith(vi.fn(), async () => Promise.reject(enotfound))
			)
		).rejects.toBe(enotfound);
	});

	it('follows redirects manually and returns the final body', async () => {
		const calls: string[] = [];
		const stub = async (url: URL | string) => {
			const href = typeof url === 'string' ? url : url.href;
			calls.push(href);
			if (href === 'https://x.example/start') {
				return new Response(null, { status: 302, headers: { location: '/final' } });
			}
			return new Response('hello world', { headers: { 'content-type': 'text/plain' } });
		};
		const result = await fetchUnit('https://x.example/start', OPTS, depsWith(stub));
		expect(result.status).toBe(200);
		expect(result.finalUrl).toBe('https://x.example/final');
		expect(result.redirects).toBe(1);
		expect(new TextDecoder().decode(result.body!)).toBe('hello world');
		expect(calls).toEqual(['https://x.example/start', 'https://x.example/final']);
	});

	it('throws LinkFetchError(redirect) after more than 5 redirects', async () => {
		let calls = 0;
		const stub = async () => {
			calls += 1;
			return new Response(null, { status: 301, headers: { location: '/next' } });
		};
		const rejected = fetchUnit('https://loop.example/', OPTS, depsWith(stub));
		await expect(rejected).rejects.toBeInstanceOf(LinkFetchError);
		await expect(rejected).rejects.toMatchObject({ code: 'redirect' });
		expect(calls).toBe(6);
	});

	it('rejects a hop that redirects off https, before requesting it', async () => {
		const resolveHost = vi.fn(async () => RESOLVED);
		const stub = async () =>
			new Response(null, { status: 302, headers: { location: 'http://x.example/next' } });
		await expect(
			fetchUnit('https://x.example/', OPTS, {
				fetch: stub as unknown as FetchUnitDeps['fetch'],
				resolveHost
			})
		).rejects.toMatchObject({ code: 'non-https' });
		expect(resolveHost).toHaveBeenCalledTimes(1);
	});

	it('re-resolves and re-validates every hop (second hop ssrf-blocked)', async () => {
		const resolveHost = vi.fn(async (host: string) => (host === 'x.example' ? RESOLVED : null));
		const stub = async () =>
			new Response(null, { status: 302, headers: { location: 'https://y.example/next' } });
		await expect(
			fetchUnit('https://x.example/', OPTS, {
				fetch: stub as unknown as FetchUnitDeps['fetch'],
				resolveHost
			})
		).rejects.toMatchObject({ code: 'ssrf' });
		expect(resolveHost).toHaveBeenCalledTimes(2);
	});

	it('bounds DNS resolution by the unit deadline', async () => {
		const slowResolve = async () => {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			return RESOLVED;
		};
		const started = Date.now();
		await expect(
			fetchUnit('https://x.example/', { ...OPTS, timeoutMs: 150 }, depsWith(vi.fn(), slowResolve))
		).rejects.toMatchObject({ name: 'TimeoutError' });
		expect(Date.now() - started).toBeLessThan(900);
	});

	it('bounds the beforeHop gate by the unit deadline', async () => {
		const slowGate = async () => {
			await new Promise((resolve) => setTimeout(resolve, 1500));
		};
		const started = Date.now();
		await expect(
			fetchUnit(
				'https://x.example/',
				{ ...OPTS, timeoutMs: 150, beforeHop: slowGate },
				depsWith(async () => new Response('ok', { status: 200 }))
			)
		).rejects.toMatchObject({ name: 'TimeoutError' });
		expect(Date.now() - started).toBeLessThan(900);
	});

	it('keeps the UA version in sync with package.json', () => {
		const pkg = JSON.parse(
			readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')
		) as { version: string };
		expect(buildUserAgent(null)).toBe(`web-lair-link-check/${pkg.version}`);
	});

	it('sends the configured user agent and builds both UA variants', async () => {
		const seen: string[] = [];
		const stub = async (_url: unknown, init: { headers: Record<string, string> }) => {
			seen.push(init.headers['user-agent']);
			return new Response('ok', { status: 200 });
		};
		await fetchUnit(
			'https://x.example/',
			{ ...OPTS, userAgent: buildUserAgent('https://lair.example') },
			{ fetch: stub as unknown as FetchUnitDeps['fetch'], resolveHost: async () => RESOLVED }
		);
		expect(seen[0]).toBe('web-lair-link-check/0.0.1 (+https://lair.example/friends)');
		expect(buildUserAgent(null)).toBe('web-lair-link-check/0.0.1');
	});

	it('surfaces Retry-After of the final response', async () => {
		const stub = async () =>
			new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
		const result = await fetchUnit('https://x.example/', OPTS, depsWith(stub));
		expect(result.status).toBe(429);
		expect(result.retryAfter).toBe('120');
	});

	it('treats a 3xx without location as the final response', async () => {
		const stub = async () => new Response(null, { status: 304 });
		const result = await fetchUnit('https://x.example/', OPTS, depsWith(stub));
		expect(result.status).toBe(304);
		expect(result.body).toBeNull();
	});

	it('caps the body and flags truncation', async () => {
		const stub = async () => new Response(new Uint8Array(5).fill(0x61)); // 'aaaaa'
		const result = await fetchUnit('https://x.example/', { ...OPTS, maxBytes: 3 }, depsWith(stub));
		expect(result.truncated).toBe(true);
		expect(result.body!.byteLength).toBe(3);
	});

	it('skips the body entirely when wantBody is false', async () => {
		const stub = async () => new Response('body text', { status: 200 });
		const result = await fetchUnit(
			'https://x.example/',
			{ ...OPTS, wantBody: false },
			depsWith(stub)
		);
		expect(result.body).toBeNull();
		expect(result.status).toBe(200);
	});

	it('runs the beforeHop hook on every hop and propagates its errors', async () => {
		const seen: string[] = [];
		const guard = new Error('robots says no');
		const stub = async () =>
			new Response(null, { status: 302, headers: { location: 'https://y.example/next' } });
		await expect(
			fetchUnit(
				'https://x.example/',
				{
					...OPTS,
					beforeHop: (url) => {
						seen.push(url.href);
						if (url.hostname === 'y.example') throw guard;
					}
				},
				depsWith(stub)
			)
		).rejects.toBe(guard);
		expect(seen).toEqual(['https://x.example/', 'https://y.example/next']);
	});
});
