import { describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { ProjectsFetchError, type FetchJson } from './fetch';
import { extractOpenGraph, resolveImportMetadata } from './import-url';

/**
 * Import prefill (plan §4.4): platform URLs resolve through their adapter;
 * everything else https falls back to a guarded OG scrape; private hosts are
 * refused before any request; failures reuse the sync's five kinds.
 */

const PUBLIC_HOST = [{ address: '93.184.216.34', family: 4 }];

function htmlResponse(html: string): Response {
	return new Response(html, {
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' }
	});
}

describe('resolveImportMetadata', () => {
	it('resolves a platform URL through its adapter (API over OG)', async () => {
		const fetchJson: FetchJson = async (url) => {
			expect(url).toBe('https://api.github.com/repos/guang/reborn');
			return {
				status: 200,
				headers: new Headers(),
				json: {
					id: 1,
					full_name: 'guang/reborn',
					html_url: 'https://github.com/guang/reborn',
					private: false,
					owner: {}
				}
			};
		};
		const result = await resolveImportMetadata('https://github.com/guang/reborn', { fetchJson });
		expect(result).toMatchObject({
			ok: true,
			kind: 'repo',
			identity: { provider: 'github', account: 'guang', repo: 'reborn' },
			meta: { externalId: '1' }
		});
	});

	it('classifies adapter failures with the sync vocabulary', async () => {
		const fetchJson: FetchJson = async () => {
			throw new ProjectsFetchError('not_found', 'HTTP 404', 404);
		};
		const result = await resolveImportMetadata('https://github.com/guang/gone', { fetchJson });
		expect(result).toEqual({ ok: false, reason: 'not_found' });
	});

	it('scrapes OpenGraph for non-platform https URLs', async () => {
		const fetch = (async () =>
			htmlResponse(
				'<html><head><title>Fallback</title><meta content="Site Title" property="og:title"><meta name="description" content="About the site"><meta property="og:image" content="https://cdn.example/i.png"></head></html>'
			)) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://lair.example/about', {
			fetch,
			resolveHost: async () => PUBLIC_HOST
		});
		expect(result).toEqual({
			ok: true,
			kind: 'og',
			url: 'https://lair.example/about',
			og: { title: 'Site Title', description: 'About the site', icon: 'https://cdn.example/i.png' }
		});
	});

	it('refuses private hosts before any request (SSRF guard)', async () => {
		let called = 0;
		const fetch = (async () => {
			called += 1;
			return htmlResponse('<html></html>');
		}) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://internal.example/panel', {
			fetch,
			resolveHost: async () => null
		});
		expect(result).toEqual({ ok: false, reason: 'blocked' });
		expect(called).toBe(0);
	});

	it('rejects non-https and unparsable URLs', async () => {
		expect(await resolveImportMetadata('ftp://lair.example/x')).toEqual({
			ok: false,
			reason: 'invalid-url'
		});
		expect(await resolveImportMetadata('not a url')).toEqual({ ok: false, reason: 'invalid-url' });
	});
});

describe('extractOpenGraph', () => {
	it('prefers og:* over twitter:* over the plain title, order-independent attrs', () => {
		const html = `
			<html><head>
				<title>Plain Title</title>
				<meta content="OG Title" property="og:title" />
				<meta name="twitter:image" content="https://cdn.example/t.png" />
				<meta property="og:description" content="OG Description" />
			</head></html>`;
		expect(extractOpenGraph(html)).toEqual({
			title: 'OG Title',
			description: 'OG Description',
			icon: 'https://cdn.example/t.png'
		});
	});

	it('falls back to <title> and name=description', () => {
		const html =
			'<html><head><title> Only Title </title><meta name="description" content="D"></head></html>';
		expect(extractOpenGraph(html)).toEqual({ title: 'Only Title', description: 'D', icon: null });
	});

	it('returns nulls for a page without metadata', () => {
		expect(extractOpenGraph('<html><body>hello</body></html>')).toEqual({
			title: null,
			description: null,
			icon: null
		});
	});
});

describe('import-url hardening (review 2026-10-08)', () => {
	function chunkedResponse(chunks: Uint8Array[]): Response {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			}
		});
		return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
	}

	it('reads multi-chunk pages past the 512KiB cap without crashing', async () => {
		const head = new TextEncoder().encode(
			'<html><head><meta property="og:title" content="Big"></head><body>'
		);
		const filler = new Uint8Array(400 * 1024);
		const fetch = (async () =>
			chunkedResponse([head, filler, filler])) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://lair.example/big', {
			fetch,
			resolveHost: async () => PUBLIC_HOST
		});
		expect(result).toMatchObject({ ok: true, kind: 'og' });
		if (result.ok && result.kind === 'og') expect(result.og.title).toBe('Big');
	});

	it('accepts a page exactly at the cap, keeping the tail', async () => {
		const tail = '<meta property="og:description" content="TAIL">';
		const base = '<title>Exact</title>';
		const padded = base + 'a'.repeat(512 * 1024 - base.length - tail.length) + tail;
		const fetch = (async () =>
			new Response(new TextEncoder().encode(padded), {
				status: 200,
				headers: { 'content-type': 'text/html' }
			})) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://lair.example/exact', {
			fetch,
			resolveHost: async () => PUBLIC_HOST
		});
		expect(result).toMatchObject({ ok: true, kind: 'og' });
		if (result.ok && result.kind === 'og') {
			expect(result.og.title).toBe('Exact');
			// The marker sits at the very end of the exactly-cap page: the
			// cap must keep the final bytes, not just the head (review
			// 2026-10-08).
			expect(result.og.description).toBe('TAIL');
		}
	});

	it('classifies mid-body stream failures as network (no raw DOMException)', async () => {
		const fetch = (async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('<html>'));
						controller.error(new Error('socket reset'));
					}
				}),
				{ status: 200, headers: { 'content-type': 'text/html' } }
			)) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://lair.example/stall', {
			fetch,
			resolveHost: async () => PUBLIC_HOST
		});
		expect(result).toEqual({ ok: false, reason: 'network' });
	});

	it('classifies DNS resolution failures as network', async () => {
		const result = await resolveImportMetadata('https://nx.example/page', {
			resolveHost: async () => {
				throw new Error('getaddrinfo ENOTFOUND nx.example');
			}
		});
		expect(result).toEqual({ ok: false, reason: 'network' });
	});

	it('follows redirects with per-hop revalidation and caps the chain', async () => {
		let calls = 0;
		const fetch = (async () => {
			calls += 1;
			if (calls <= 2) {
				return new Response(null, { status: 302, headers: { location: `/hop${calls}` } });
			}
			return htmlResponse('<meta property="og:title" content="Hopped">');
		}) as unknown as typeof undiciFetch;
		let resolves = 0;
		const result = await resolveImportMetadata('https://lair.example/start', {
			fetch,
			resolveHost: async () => {
				resolves += 1;
				return PUBLIC_HOST;
			}
		});
		expect(result).toMatchObject({ ok: true, kind: 'og' });
		if (result.ok && result.kind === 'og') {
			expect(result.og.title).toBe('Hopped');
			expect(result.url).toBe('https://lair.example/hop2');
		}
		expect(resolves).toBe(3);

		const loop = (async () =>
			new Response(null, {
				status: 302,
				headers: { location: '/x' }
			})) as unknown as typeof undiciFetch;
		const capped = await resolveImportMetadata('https://lair.example/loop', {
			fetch: loop,
			resolveHost: async () => PUBLIC_HOST
		});
		expect(capped).toEqual({ ok: false, reason: 'network' });
	});

	it('rejects non-HTML content types as parse', async () => {
		const fetch = (async () =>
			new Response('{}', {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://lair.example/api', {
			fetch,
			resolveHost: async () => PUBLIC_HOST
		});
		expect(result).toEqual({ ok: false, reason: 'parse' });
	});

	it('decodes the declared charset', async () => {
		const text = '<meta property="og:title" content="caf\u00e9">';
		const bytes = Uint8Array.from([...text].map((ch) => ch.charCodeAt(0) & 0xff));
		const fetch = (async () =>
			new Response(bytes, {
				status: 200,
				headers: { 'content-type': 'text/html; charset=iso-8859-1' }
			})) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://lair.example/latin', {
			fetch,
			resolveHost: async () => PUBLIC_HOST
		});
		if (!result.ok || result.kind !== 'og') throw new Error('expected og result');
		expect(result.og.title).toBe('caf\u00e9');
	});

	it('clips prefill text, strips controls and resolves relative icons', async () => {
		const long = 'y'.repeat(600);
		const html = `<meta property="og:title" content="${long}"><meta name="description" content="line\u0001break\u200e\u200f"><meta property="og:image" content="/img/pic.png">`;
		const fetch = (async () => htmlResponse(html)) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://lair.example/page', {
			fetch,
			resolveHost: async () => PUBLIC_HOST
		});
		if (!result.ok || result.kind !== 'og') throw new Error('expected og result');
		expect(result.og.title).toHaveLength(300);
		// C0 control and LRM both reduce to spaces, then collapse (review
		// 2026-10-08).
		expect(result.og.description).toBe('line break');
		expect(result.og.icon).toBe('https://lair.example/img/pic.png');

		const dataFetch = (async () =>
			htmlResponse(
				'<meta property="og:image" content="data:image/png;base64,AAAA">'
			)) as unknown as typeof undiciFetch;
		const dataResult = await resolveImportMetadata('https://lair.example/page', {
			fetch: dataFetch,
			resolveHost: async () => PUBLIC_HOST
		});
		if (!dataResult.ok || dataResult.kind !== 'og') throw new Error('expected og result');
		expect(dataResult.og.icon).toBeNull();
	});

	it('caps titles by code points (no split surrogate pairs)', async () => {
		const html = `<meta property="og:title" content="${'a' + '😀'.repeat(400)}">`;
		const fetch = (async () => htmlResponse(html)) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://lair.example/astral', {
			fetch,
			resolveHost: async () => PUBLIC_HOST
		});
		if (!result.ok || result.kind !== 'og') throw new Error('expected og result');
		const title = result.og.title ?? '';
		expect([...title]).toHaveLength(300);
		expect(title.endsWith('\u{1F600}')).toBe(true);
	});

	it('keeps the tail of the kept range when a chunk crosses the cap', async () => {
		const head = '<html><head><meta property="og:title" content="Cut">';
		const marker = '<meta property="og:description" content="TAILX">';
		const cap = 512 * 1024;
		const chunks = [
			new TextEncoder().encode(head),
			new TextEncoder().encode('b'.repeat(cap - head.length - marker.length) + marker + 'cccc'),
			new TextEncoder().encode('<meta property="og:url" content="/late">')
		];
		const fetch = (async () => chunkedResponse(chunks)) as unknown as typeof undiciFetch;
		const result = await resolveImportMetadata('https://lair.example/cut', {
			fetch,
			resolveHost: async () => PUBLIC_HOST
		});
		if (!result.ok || result.kind !== 'og') throw new Error('expected og result');
		expect(result.og.title).toBe('Cut');
		expect(result.og.description).toBe('TAILX');
	});
});
