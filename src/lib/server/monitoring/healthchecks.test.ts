import { describe, expect, it, vi } from 'vitest';
import {
	HEALTHCHECK_ENV,
	HEALTHCHECK_TIMEOUT_MS,
	healthcheckUrl,
	pingHealthcheck
} from './healthchecks';

const env = (values: Record<string, string>): Record<string, string | undefined> => values;

describe('healthcheckUrl', () => {
	it('appends /fail only for a failure and normalises trailing slashes', () => {
		const base = 'https://hc-ping.com/11111111-2222-3333-4444-555555555555';
		expect(healthcheckUrl('resources', 'ok', env({ [HEALTHCHECK_ENV.resources]: base }))).toBe(
			base
		);
		expect(
			healthcheckUrl('resources', 'fail', env({ [HEALTHCHECK_ENV.resources]: `${base}//` }))
		).toBe(`${base}/fail`);
		expect(healthcheckUrl('mail', 'ok', env({ [HEALTHCHECK_ENV.mail]: base }))).toBe(base);
	});

	it('keeps the two probes on separate checks', () => {
		expect(healthcheckUrl('resources', 'ok', env({ [HEALTHCHECK_ENV.mail]: 'https://x' }))).toBe(
			null
		);
		expect(healthcheckUrl('mail', 'fail', env({ [HEALTHCHECK_ENV.resources]: 'https://y' }))).toBe(
			null
		);
	});

	it('is null when the check is not configured', () => {
		expect(healthcheckUrl('resources', 'fail', env({}))).toBeNull();
		expect(
			healthcheckUrl('resources', 'fail', env({ [HEALTHCHECK_ENV.resources]: '  ' }))
		).toBeNull();
	});
});

describe('pingHealthcheck', () => {
	it('skips without a URL', async () => {
		const fetchImpl = vi.fn();
		await expect(
			pingHealthcheck('resources', 'fail', {
				env: {},
				fetchImpl: fetchImpl as unknown as typeof fetch
			})
		).resolves.toBe('skipped');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('pings the base URL for ok and /fail for a failure', async () => {
		const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
		const configured = env({ [HEALTHCHECK_ENV.resources]: 'https://hc-ping.com/uuid/' });
		await expect(
			pingHealthcheck('resources', 'ok', { env: configured, fetchImpl: fetchImpl as never })
		).resolves.toBe('ok');
		expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('https://hc-ping.com/uuid');
		await expect(
			pingHealthcheck('resources', 'fail', { env: configured, fetchImpl: fetchImpl as never })
		).resolves.toBe('ok');
		expect((fetchImpl.mock.calls[1] as unknown[])[0]).toBe('https://hc-ping.com/uuid/fail');
		const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
		expect(init.method).toBe('GET');
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('reports fail on a non-2xx answer and never throws', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
		await expect(
			pingHealthcheck('mail', 'fail', {
				env: env({ [HEALTHCHECK_ENV.mail]: 'https://hc-ping.com/uuid' }),
				fetchImpl: fetchImpl as never
			})
		).resolves.toBe('fail');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('503'));
		// The check URL carries the UUID: never in the log.
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('hc-ping.com'));
		warn.mockRestore();
	});

	it('keeps the 10s bound and turns an aborted fetch into fail', async () => {
		expect(HEALTHCHECK_TIMEOUT_MS).toBe(10_000);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchImpl = ((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				const signal = init.signal as AbortSignal;
				const fail = () => reject(signal.reason ?? new Error('aborted'));
				if (signal.aborted) fail();
				else signal.addEventListener('abort', fail, { once: true });
			})) as unknown as typeof fetch;
		await expect(
			pingHealthcheck('resources', 'ok', {
				env: env({ [HEALTHCHECK_ENV.resources]: 'https://hc-ping.com/uuid' }),
				fetchImpl,
				timeoutMs: 5
			})
		).resolves.toBe('fail');
		warn.mockRestore();
	});

	it('swallows network errors', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(
			pingHealthcheck('mail', 'ok', {
				env: env({ [HEALTHCHECK_ENV.mail]: 'https://hc-ping.com/uuid' }),
				fetchImpl: (async () => {
					throw new TypeError('fetch failed');
				}) as unknown as typeof fetch
			})
		).resolves.toBe('fail');
		// The check URL carries the UUID: never in the log.
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('mail'));
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('hc-ping.com'));
		warn.mockRestore();
	});
});
