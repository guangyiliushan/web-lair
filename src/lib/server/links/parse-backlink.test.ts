import { describe, expect, it } from 'vitest';
import { decodeHtmlBody, findBacklink } from './parse-backlink';

const PAGE = 'https://page.example/post';
const ACCEPTED = ['us.example'];

describe('findBacklink (§4.8)', () => {
	it('finds a plain absolute link', () => {
		const found = findBacklink('<p><a href="https://us.example/">hi</a></p>', PAGE, ACCEPTED);
		expect(found.found).toBe(true);
		expect(found.href).toBe('https://us.example/');
	});

	it('resolves relative hrefs against the page URL', () => {
		expect(findBacklink('<a href="/x">y</a>', PAGE, ['page.example']).found).toBe(true);
		expect(findBacklink('<a href="x">y</a>', PAGE, ['page.example']).href).toBe(
			'https://page.example/x'
		);
	});

	it('does not match links inside comments or script data', () => {
		expect(findBacklink('<!-- <a href="https://us.example/"> -->', PAGE, ACCEPTED).found).toBe(
			false
		);
		expect(
			findBacklink('<script>const t = \'<a href="https://us.example/">\';</script>', PAGE, ACCEPTED)
				.found
		).toBe(false);
	});

	it('decodes entity-encoded hrefs (tokenizer-level) and uppercased markup', () => {
		const found = findBacklink('<A HREF="https://us.example/?a=1&amp;b=2">x</A>', PAGE, ACCEPTED);
		expect(found.found).toBe(true);
		expect(found.href).toBe('https://us.example/?a=1&b=2');
	});

	it('matches www variants via normalization and records rel=nofollow / http', () => {
		const wwwFound = findBacklink('<a href="https://www.us.example/">x</a>', PAGE, ACCEPTED);
		expect(wwwFound.found).toBe(true);

		const nofollow = findBacklink(
			'<a href="https://us.example/" rel="noopener nofollow">x</a>',
			PAGE,
			ACCEPTED
		);
		expect(nofollow.found).toBe(true);
		expect(nofollow.notes).toContain('rel=nofollow');

		const http = findBacklink('<a href="http://us.example/">x</a>', PAGE, ACCEPTED);
		expect(http.found).toBe(true);
		expect(http.notes).toContain('http link');
	});

	it('honors <base href> for relative link resolution', () => {
		const html = '<head><base href="https://other.example/dir/"></head><a href="/x">y</a>';
		expect(findBacklink(html, PAGE, ['other.example']).found).toBe(true);
		expect(findBacklink(html, PAGE, ACCEPTED).found).toBe(false);
		expect(findBacklink(html, PAGE, ['other.example']).notes).toContain('via <base>');
	});

	it('reports absence when no accepted-host link exists', () => {
		expect(findBacklink('<a href="https://unrelated.example/">x</a>', PAGE, ACCEPTED).found).toBe(
			false
		);
	});

	it('keeps <plaintext> immune to a literal </plaintext> (WHATWG PLAINTEXT)', () => {
		expect(
			findBacklink('<plaintext><a href="https://us.example/">x</a>', PAGE, ACCEPTED).found
		).toBe(false);
		expect(
			findBacklink('<plaintext>x</plaintext><a href="https://us.example/">y</a>', PAGE, ACCEPTED)
				.found
		).toBe(false);
	});

	it('ignores non-http(s) schemes', () => {
		expect(findBacklink('<a href="ftp://us.example/x">y</a>', PAGE, ACCEPTED).found).toBe(false);
	});
});

describe('decodeHtmlBody (§4.8 sniff order)', () => {
	const encoder = new TextEncoder();

	it('defaults to UTF-8', () => {
		expect(decodeHtmlBody(encoder.encode('héllo'), null)).toBe('héllo');
	});

	it('BOM beats the transport charset', () => {
		// UTF-16LE BOM + "abc" in UTF-16LE: with the BOM claimed correctly,
		// the transport charset (shift_jis) must not apply.
		const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00, 0x63, 0x00]);
		expect(decodeHtmlBody(bytes, 'text/html; charset=shift_jis')).toBe('abc');
	});

	it('honors the Content-Type charset parameter (shift_jis)', () => {
		const bytes = new Uint8Array([0x82, 0xa0]); // 'あ' in Shift_JIS
		expect(decodeHtmlBody(bytes, 'text/html; charset=Shift_JIS')).toBe('あ');
	});

	it('prescans a <meta charset> in the first 1024 bytes (euc-jp)', () => {
		const meta = encoder.encode('<meta charset="euc-jp">');
		const hangul = new Uint8Array([0xb4, 0xc1]); // '漢' in EUC-JP
		const bytes = new Uint8Array([...meta, ...hangul]);
		expect(decodeHtmlBody(bytes, null)).toBe('<meta charset="euc-jp">漢');
	});

	it('falls back to UTF-8 on unknown labels', () => {
		expect(decodeHtmlBody(encoder.encode('ok'), 'text/html; charset=definitely-not-real')).toBe(
			'ok'
		);
	});
});
