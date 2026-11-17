import { describe, expect, it, vi } from 'vitest';
import {
	BARK_DEFAULT_SERVER,
	BARK_GROUP,
	barkResponseSucceeded,
	barkStatusIsPermanent,
	buildBarkBody,
	readBarkConfig,
	sendBarkNotification
} from './bark';

/**
 * Bark adapter teeth: the key
 * travels in the JSON body (never a URL segment), the SSRF guard runs before
 * the fetch, a body-level `code` decides permanence, and no failure string
 * carries the device key.
 */
const KEY = 'device-key-should-never-leak';

function env(values: Record<string, string | undefined>) {
	return (name: string) => values[name];
}

function jsonResponse(status: number, body: unknown) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => body
	} as unknown as Response;
}

describe('readBarkConfig', () => {
	it('defaults to the official server and reports the missing key', () => {
		const config = readBarkConfig(env({}));
		expect(config.serverUrl).toBe(BARK_DEFAULT_SERVER);
		expect(config.configured).toBe(false);
		expect(config.reason).toBe('missing-key');
	});

	it('keeps only the origin of a configured server (no path, no key)', () => {
		const config = readBarkConfig(
			env({ BARK_SERVER_URL: 'https://bark.example/key-in-path', BARK_DEVICE_KEY: KEY })
		);
		expect(config.configured).toBe(true);
		expect(config.serverUrl).toBe('https://bark.example');
	});

	it('rejects a non-http server value', () => {
		const config = readBarkConfig(
			env({ BARK_SERVER_URL: 'ftp://bark.example', BARK_DEVICE_KEY: KEY })
		);
		expect(config.configured).toBe(false);
		expect(config.reason).toBe('invalid-server');
	});
});

describe('buildBarkBody', () => {
	it('puts the device key in the body, never in the URL', () => {
		const body = buildBarkBody({
			deviceKey: KEY,
			title: 't',
			body: 'b',
			url: 'https://lair.example/x'
		});
		expect(body).toMatchObject({
			device_key: KEY,
			title: 't',
			body: 'b',
			group: BARK_GROUP,
			level: 'active',
			url: 'https://lair.example/x'
		});
	});
});

describe('response classification', () => {
	it('accepts 2xx with no code or code 200', () => {
		expect(barkResponseSucceeded(200, { code: 200 })).toBe(true);
		expect(barkResponseSucceeded(200, null)).toBe(true);
		expect(barkResponseSucceeded(200, { code: 400 })).toBe(false);
		expect(barkResponseSucceeded(500, { code: 200 })).toBe(false);
	});

	it('treats 4xx (except 429) as permanent and 429/5xx as retryable', () => {
		expect(barkStatusIsPermanent(400)).toBe(true);
		expect(barkStatusIsPermanent(403)).toBe(true);
		expect(barkStatusIsPermanent(429)).toBe(false);
		expect(barkStatusIsPermanent(500)).toBe(false);
	});
});

describe('sendBarkNotification', () => {
	const okEnv = env({ BARK_SERVER_URL: 'https://bark.example', BARK_DEVICE_KEY: KEY });

	it('POSTs /push with the key in the body and no key in the URL', async () => {
		const fetchMock = vi.fn(async () => jsonResponse(200, { code: 200, message: 'success' }));
		const result = await sendBarkNotification(
			{ title: 'Disk high', body: 'disk /data at 91%' },
			{ getEnv: okEnv, fetch: fetchMock as unknown as typeof fetch }
		);
		expect(result).toEqual({ ok: true, responseCode: 200 });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://bark.example/push');
		expect(String(init.body)).toContain(KEY);
		expect(url).not.toContain(KEY);
	});

	it('reports a body-level 400 as a permanent failure', async () => {
		const fetchMock = vi.fn(async () => jsonResponse(200, { code: 400, message: 'bad key' }));
		const result = await sendBarkNotification(
			{ title: 't', body: 'b' },
			{ getEnv: okEnv, fetch: fetchMock as unknown as typeof fetch }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.permanent).toBe(true);
			expect(result.error).toContain('bark code 400');
		}
	});

	it('treats 5xx and transport errors as retryable', async () => {
		const fiveHundred = await sendBarkNotification(
			{ title: 't', body: 'b' },
			{ getEnv: okEnv, fetch: (async () => jsonResponse(503, {})) as unknown as typeof fetch }
		);
		expect(fiveHundred).toMatchObject({ ok: false, permanent: false, responseCode: 503 });

		const thrown = await sendBarkNotification(
			{ title: 't', body: 'b' },
			{
				getEnv: okEnv,
				fetch: (async () => {
					throw new Error(`connect ECONNREFUSED https://bark.example/push?key=${KEY}`);
				}) as unknown as typeof fetch
			}
		);
		expect(thrown).toMatchObject({ ok: false, permanent: false });
		if (!thrown.ok) expect(thrown.error).not.toContain(KEY);
	});

	it('refuses a private/loopback server before any fetch (SSRF)', async () => {
		const fetchMock = vi.fn();
		const result = await sendBarkNotification(
			{ title: 't', body: 'b' },
			{
				getEnv: env({ BARK_SERVER_URL: 'https://127.0.0.1:8443', BARK_DEVICE_KEY: KEY }),
				fetch: fetchMock as unknown as typeof fetch
			}
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.permanent).toBe(true);
			expect(result.error).toContain('blocked bark target');
		}
	});

	it('is a permanent failure when unconfigured (no key)', async () => {
		const result = await sendBarkNotification({ title: 't', body: 'b' }, { getEnv: env({}) });
		expect(result).toMatchObject({ ok: false, permanent: true });
		if (!result.ok) expect(result.error).toContain('not configured');
	});

	it('refuses an empty payload', async () => {
		const result = await sendBarkNotification({ title: '', body: '' }, { getEnv: okEnv });
		expect(result).toMatchObject({ ok: false, permanent: true, error: 'payload is empty' });
	});
});
