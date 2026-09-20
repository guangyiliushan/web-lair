import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();
vi.mock('node:dns', () => ({ promises: { lookup: (...args: unknown[]) => lookup(...args) } }));

const fetchMock = vi.fn();

import { handleFaviconRequest, isPrivateAddress } from '$lib/server/favicon-proxy';

beforeEach(() => {
	lookup.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

const publicLookup = () => lookup.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
const imageResponse = (bytes = 4, type = 'image/png') =>
	new Response(new Uint8Array(bytes).fill(1), {
		status: 200,
		headers: { 'content-type': type }
	});
const request = (target: string) =>
	handleFaviconRequest(new URL(`https://site/api/favicon?url=${encodeURIComponent(target)}`));

describe('favicon proxy (spec 6)', () => {
	it('classifies private and public addresses', () => {
		for (const address of [
			'127.0.0.1',
			'10.1.2.3',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			'169.254.1.1',
			'100.64.0.1',
			'0.0.0.0',
			'::1',
			'fc00::1',
			'fd12::1',
			'fe80::1',
			'::ffff:127.0.0.1'
		]) {
			expect(isPrivateAddress(address), address).toBe(true);
		}
		for (const address of ['140.82.112.3', '8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
			expect(isPrivateAddress(address), address).toBe(false);
		}
	});

	it('rejects missing, invalid and non-web targets', async () => {
		await expect(handleFaviconRequest(new URL('https://site/api/favicon'))).rejects.toMatchObject({
			status: 400
		});
		await expect(request('not a url')).rejects.toMatchObject({ status: 400 });
		await expect(request('data:image/png,x')).rejects.toMatchObject({ status: 400 });
	});

	it('rejects non-allowlisted domains (exact match, www canonicalised)', async () => {
		await expect(request('https://evil.example/')).rejects.toMatchObject({ status: 403 });
		await expect(request('https://github.com.evil.example/')).rejects.toMatchObject({
			status: 403
		});
	});

	it('rejects hostnames resolving to private addresses or nothing', async () => {
		lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		await expect(request('https://github.com/')).rejects.toMatchObject({ status: 403 });
		lookup.mockResolvedValue([]);
		await expect(request('https://github.com/')).rejects.toMatchObject({ status: 403 });
	});

	it('fetches allowlisted favicons with the no-redirect contract and cache headers', async () => {
		publicLookup();
		fetchMock.mockResolvedValue(imageResponse());
		const response = await request('https://www.github.com/foo/bar');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('cache-control')).toContain('max-age=86400');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		const call = fetchMock.mock.calls[0];
		expect(call[0]).toBe('https://github.com/favicon.ico');
		expect(call[1].redirect).toBe('error');
	});

	it('rejects non-image content types and oversize bodies', async () => {
		publicLookup();
		fetchMock.mockResolvedValue(
			new Response('hello', { status: 200, headers: { 'content-type': 'text/html' } })
		);
		await expect(request('https://github.com/')).rejects.toMatchObject({ status: 502 });
		fetchMock.mockResolvedValue(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(400 * 1024));
						controller.enqueue(new Uint8Array(400 * 1024));
						controller.close();
					}
				}),
				{ status: 200, headers: { 'content-type': 'image/png' } }
			)
		);
		await expect(request('https://github.com/')).rejects.toMatchObject({ status: 502 });
	});
});
