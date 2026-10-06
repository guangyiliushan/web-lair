import { describe, expect, it, vi } from 'vitest';
import { checkSite, SCAN_BODY_BYTES, type SiteCheckConfig, type SiteCheckDeps } from './check-site';
import { LinkFetchError } from './fetch';
import type { RobotsOracle } from './robots';

const HOME = 'https://home.example/';
const PARTNER = 'https://partner.example/page';

function allowOracle(): RobotsOracle {
	return {
		decisionFor: vi.fn(async () => ({ kind: 'allow' as const, reason: 'test' }))
	};
}

function depsWith(fetchImpl: unknown, oracle: RobotsOracle = allowOracle()): SiteCheckDeps {
	return {
		oracle,
		fetchDeps: {
			fetch: fetchImpl as never,
			resolveHost: async () => [{ address: '93.184.216.34', family: 4 }]
		},
		sleepMs: async () => {}
	};
}

function config(overrides: Partial<SiteCheckConfig> = {}): SiteCheckConfig {
	return {
		userAgent: 'web-lair-link-check/0.0.1',
		timeoutMs: 1000,
		backlinkEnabled: true,
		acceptedBacklinkHosts: ['us.example'],
		retryOnce: false,
		now: () => new Date('2026-10-06T00:00:00Z'),
		...overrides
	};
}

function routes(map: Record<string, () => Response>) {
	return vi.fn(async (url: URL | string) => {
		const href = typeof url === 'string' ? url : url.href;
		const handler = map[href];
		if (!handler) throw new Error(`unexpected fetch: ${href}`);
		return handler();
	});
}

const pageWithLink = () =>
	new Response('<a href="https://us.example/">hi</a>', {
		status: 200,
		headers: { 'content-type': 'text/html' }
	});
const pageNoLink = () =>
	new Response('<p>nothing here</p>', { status: 200, headers: { 'content-type': 'text/html' } });

describe('checkSite (§4.1/§4.8)', () => {
	it('reach ok + backlink found (two fetches)', async () => {
		const stub = routes({ [HOME]: pageNoLink, [PARTNER]: pageWithLink });
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			depsWith(stub)
		);
		expect(outcome.reach).toBe('ok');
		expect(outcome.backlink).toBe('ok');
		expect(outcome.entries).toHaveLength(2);
		expect(stub).toHaveBeenCalledTimes(2);
	});

	it('backlink missing when the page has no accepted link', async () => {
		const stub = routes({ [HOME]: pageNoLink, [PARTNER]: pageNoLink });
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			depsWith(stub)
		);
		expect(outcome.backlink).toBe('missing');
		expect(outcome.entries[1]).toMatchObject({ kind: 'backlink', err: 'link_missing', ok: false });
	});

	it('same-target pages are fetched once and serve both axes', async () => {
		const stub = routes({ [HOME]: pageWithLink });
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: HOME },
			config(),
			depsWith(stub)
		);
		expect(stub).toHaveBeenCalledTimes(1);
		expect(outcome.reach).toBe('ok');
		expect(outcome.backlink).toBe('ok');
	});

	it('robots disallow skips the site without fetching and without failure', async () => {
		const stub = routes({});
		const oracle: RobotsOracle = {
			decisionFor: vi.fn(async () => ({ kind: 'disallow' as const, reason: 'disallow: /' }))
		};
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			depsWith(stub, oracle)
		);
		expect(outcome.reach).toBe('skipped');
		expect(outcome.entries[0]).toMatchObject({ err: 'robots' });
		expect(stub).not.toHaveBeenCalled();
	});

	it('waf statuses are not counted (skipped axis)', async () => {
		const stub = routes({ [HOME]: () => new Response('nope', { status: 403 }) });
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: null },
			config(),
			depsWith(stub)
		);
		expect(outcome.reach).toBe('skipped');
		expect(outcome.entries[0]).toMatchObject({ err: 'waf', http: 403 });
	});

	it('failed declared page falls back to the homepage for the link scan', async () => {
		const stub = routes({
			[HOME]: pageWithLink,
			[PARTNER]: () => new Response('gone', { status: 404 })
		});
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			depsWith(stub)
		);
		expect(outcome.backlink).toBe('ok');
		expect(outcome.entries[1].note).toContain('fallback: homepage');
		expect(stub).toHaveBeenCalledTimes(3);
	});

	it('failed page + homepage without link = page_missing', async () => {
		const stub = routes({
			[HOME]: pageNoLink,
			[PARTNER]: () => new Response('gone', { status: 404 })
		});
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			depsWith(stub)
		);
		expect(outcome.backlink).toBe('missing');
		expect(outcome.entries[1]).toMatchObject({ err: 'page_missing' });
	});

	it('truncated scans are inconclusive (no streak movement)', async () => {
		const big = 'x'.repeat(SCAN_BODY_BYTES + 1024);
		const stub = routes({
			[HOME]: pageNoLink,
			[PARTNER]: () => new Response(big, { status: 200, headers: { 'content-type': 'text/html' } })
		});
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			depsWith(stub)
		);
		expect(outcome.backlink).toBe('inconclusive');
		expect(outcome.entries[1].note).toBe('truncated');
	});

	it('retries timeout/5xx once in-run with the 30 s gap', async () => {
		let partnerCalls = 0;
		const stub = vi.fn(async (url: URL | string) => {
			const href = typeof url === 'string' ? url : url.href;
			if (href === HOME) return pageNoLink();
			partnerCalls += 1;
			if (partnerCalls === 1) return new Response('overloaded', { status: 500 });
			return pageWithLink();
		});
		const sleep = vi.fn(async () => {});
		const deps = depsWith(stub);
		deps.sleepMs = sleep;
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config({ retryOnce: true }),
			deps
		);
		expect(outcome.backlink).toBe('ok');
		expect(partnerCalls).toBe(2);
		expect(sleep).toHaveBeenCalledWith(30_000);
	});

	it('disables the backlink axis cleanly when origin-missing', async () => {
		const stub = routes({ [HOME]: pageNoLink });
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config({ backlinkEnabled: false }),
			depsWith(stub)
		);
		expect(outcome.backlink).toBe('skipped');
		expect(outcome.notes.join('; ')).toContain('origin-missing');
		expect(stub).toHaveBeenCalledTimes(1);
	});

	it('dns-dead hosts count as hard failures (no robots masking)', async () => {
		const stub = routes({});
		const deps = depsWith(stub);
		deps.fetchDeps = {
			fetch: stub as never,
			resolveHost: async () => {
				throw Object.assign(new Error('getaddrinfo ENOTFOUND dead.invalid'), {
					code: 'ENOTFOUND'
				});
			}
		};
		const outcome = await checkSite(
			{ url: 'https://dead.invalid/', host: 'dead.invalid', backlinkUrl: null },
			config(),
			deps
		);
		expect(outcome.reach).toBe('fail');
		expect(outcome.entries[0]).toMatchObject({ err: 'dns', ok: false });
		expect(stub).not.toHaveBeenCalled();
	});

	it('records an offsite note when the final URL crossed sites', async () => {
		const stub = routes({
			[HOME]: () =>
				new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } }),
			['https://elsewhere.example/']: pageNoLink
		});
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: null },
			config(),
			depsWith(stub)
		);
		expect(outcome.reach).toBe('ok');
		expect(outcome.entries[0].note).toContain('offsite');
	});

	it('retries a thrown timeout once (retryOnce: true)', async () => {
		let partnerCalls = 0;
		const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		const stub = vi.fn(async (url: URL | string) => {
			const href = typeof url === 'string' ? url : url.href;
			if (href === HOME) return pageNoLink();
			partnerCalls += 1;
			if (partnerCalls === 1) throw timeoutError;
			return pageWithLink();
		});
		const sleep = vi.fn(async () => {});
		const deps = depsWith(stub);
		deps.sleepMs = sleep;
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config({ retryOnce: true }),
			deps
		);
		expect(outcome.backlink).toBe('ok');
		expect(partnerCalls).toBe(2);
		expect(sleep).toHaveBeenCalledWith(30_000);
	});

	it('does not retry when retryOnce is false', async () => {
		let partnerCalls = 0;
		const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		const stub = vi.fn(async (url: URL | string) => {
			const href = typeof url === 'string' ? url : url.href;
			if (href === HOME) return pageNoLink();
			partnerCalls += 1;
			throw timeoutError;
		});
		const sleep = vi.fn(async () => {});
		const deps = depsWith(stub);
		deps.sleepMs = sleep;
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			deps
		);
		expect(partnerCalls).toBe(1);
		expect(sleep).not.toHaveBeenCalled();
		expect(outcome.backlink).toBe('missing');
	});

	it('skips the in-run retry when the budget gate denies it', async () => {
		let partnerCalls = 0;
		const stub = vi.fn(async (url: URL | string) => {
			const href = typeof url === 'string' ? url : url.href;
			if (href === HOME) return pageNoLink();
			partnerCalls += 1;
			return new Response('overloaded', { status: 500 });
		});
		const sleep = vi.fn(async () => {});
		const deps = depsWith(stub);
		deps.sleepMs = sleep;
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config({ retryOnce: true, retryAllowed: () => false }),
			deps
		);
		expect(partnerCalls).toBe(1);
		expect(sleep).not.toHaveBeenCalled();
		expect(outcome.backlink).toBe('missing');
	});

	it('records Retry-After on a 429 page (waf, not counted)', async () => {
		const stub = routes({
			[HOME]: pageNoLink,
			[PARTNER]: () => new Response('slow', { status: 429, headers: { 'retry-after': '120' } })
		});
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			depsWith(stub)
		);
		expect(outcome.backlink).toBe('skipped');
		expect(outcome.entries[1]).toMatchObject({ err: 'waf' });
		expect(outcome.entries[1].note).toContain('retry-after 120');
	});

	it('non-html declared pages are inconclusive', async () => {
		const stub = routes({
			[HOME]: pageNoLink,
			[PARTNER]: () =>
				new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } })
		});
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			depsWith(stub)
		);
		expect(outcome.backlink).toBe('inconclusive');
		expect(outcome.entries[1].note).toBe('non-html: application/pdf');
	});

	it('robots unreachable skips without counting', async () => {
		const oracle: RobotsOracle = {
			decisionFor: vi.fn(async () => ({ kind: 'unreachable' as const, reason: 'http 503' }))
		};
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: null },
			config(),
			depsWith(routes({}), oracle)
		);
		expect(outcome.reach).toBe('skipped');
		expect(outcome.entries[0]).toMatchObject({ err: 'robots' });
		expect(outcome.entries[0].note).toContain('unavailable');
	});

	it('same-target with a failed homepage leaves the backlink axis skipped', async () => {
		const stub = routes({});
		const deps = depsWith(stub);
		deps.fetchDeps = {
			fetch: stub as never,
			resolveHost: async () => {
				throw Object.assign(new Error('getaddrinfo ENOTFOUND home.example'), {
					code: 'ENOTFOUND'
				});
			}
		};
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: HOME },
			config(),
			deps
		);
		expect(outcome.reach).toBe('fail');
		expect(outcome.backlink).toBe('skipped');
		expect(outcome.notes.join('; ')).toContain('homepage fetch failed');
		expect(stub).not.toHaveBeenCalled();
	});

	it('ssrf-refused targets are skipped, not counted', async () => {
		const stub = routes({});
		const deps = depsWith(stub);
		deps.fetchDeps = { fetch: stub as never, resolveHost: async () => null };
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: null },
			config(),
			deps
		);
		expect(outcome.reach).toBe('skipped');
		expect(outcome.entries[0]).toMatchObject({ err: 'unsupported' });
		expect(stub).not.toHaveBeenCalled();
	});

	it('a redirect-overflow declared page falls back to the homepage', async () => {
		const stub = vi.fn(async (url: URL | string) => {
			const href = typeof url === 'string' ? url : url.href;
			if (href === HOME) return pageWithLink();
			throw new LinkFetchError('redirect', 'more than 5 redirects');
		});
		const outcome = await checkSite(
			{ url: HOME, host: 'home.example', backlinkUrl: PARTNER },
			config(),
			depsWith(stub)
		);
		expect(outcome.backlink).toBe('ok');
		expect(outcome.entries[1].note).toContain('fallback: homepage');
	});
});
