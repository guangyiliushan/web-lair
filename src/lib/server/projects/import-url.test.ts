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
