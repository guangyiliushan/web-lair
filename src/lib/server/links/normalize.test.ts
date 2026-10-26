import { describe, expect, it } from 'vitest';
import {
	isSameSite,
	normalizeHost,
	normalizeLinkUrl,
	redactCredentials,
	stripWww,
	urlKey
} from './normalize';

describe('links normalize (§2.1)', () => {
	it('strips one leading www and trailing dots, lowercases', () => {
		expect(stripWww('www.example.com')).toBe('example.com');
		expect(stripWww('w.example.com')).toBe('w.example.com');
		expect(normalizeHost('EXAMPLE.com')).toBe('example.com');
		expect(normalizeHost('www.Example.com.')).toBe('example.com');
		expect(normalizeHost('sub.www.example.com')).toBe('sub.www.example.com');
	});

	it('accepts bare hosts and full URLs, punycodes IDNs (URL does)', () => {
		expect(normalizeHost('https://WWW.foo.co.uk:8443/x')).toBe('foo.co.uk');
		expect(normalizeHost('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
		expect(normalizeHost('')).toBeNull();
		expect(normalizeHost('not a host')).toBeNull();
	});

	it('redactCredentials strips URL userinfo from free text', () => {
		expect(redactCredentials('boom https://user:pass@host/x')).toBe(
			'boom https://[redacted]@host/x'
		);
		expect(redactCredentials('no credentials here')).toBe('no credentials here');
		expect(redactCredentials('https://a:b@h/ and https://c@h/')).toBe(
			'https://[redacted]@h/ and https://[redacted]@h/'
		);
	});

	it('isSameSite treats equal hosts and subdomain relations as same site', () => {
		expect(isSameSite('example.com', 'www.example.com')).toBe(true);
		expect(isSameSite('blog.example.com', 'example.com')).toBe(true);
		expect(isSameSite('example.com', 'example.org')).toBe(false);
		expect(isSameSite('notexample.com', 'example.com')).toBe(false);
		expect(isSameSite('', 'example.com')).toBe(false);
	});

	it('urlKey drops the fragment only', () => {
		expect(urlKey('https://example.com/a#x')).toBe('https://example.com/a');
		expect(urlKey('https://example.com/a')).toBe('https://example.com/a');
		expect(urlKey('nope')).toBeNull();
	});
});

describe('normalizeLinkUrl (admin write form, plan §2.1)', () => {
	it('accepts a bare host and canonicalises it to https', () => {
		expect(normalizeLinkUrl('example.com')).toEqual({
			ok: true,
			url: 'https://example.com',
			host: 'example.com'
		});
	});

	it('lowercases the host but keeps the url host as entered', () => {
		expect(normalizeLinkUrl('https://WWW.Example.COM/')).toEqual({
			ok: true,
			url: 'https://www.example.com',
			host: 'example.com'
		});
	});

	it('drops default ports and trailing slashes, keeps other ports', () => {
		expect(normalizeLinkUrl('https://example.com:443/')).toEqual({
			ok: true,
			url: 'https://example.com',
			host: 'example.com'
		});
		expect(normalizeLinkUrl('https://example.com:8443/')).toEqual({
			ok: true,
			url: 'https://example.com:8443',
			host: 'example.com'
		});
	});

	it('rejects non-https, userinfo, query and fragment', () => {
		expect(normalizeLinkUrl('http://example.com')).toEqual({ ok: false, reason: 'insecure' });
		expect(normalizeLinkUrl('https://user:pass@example.com')).toEqual({
			ok: false,
			reason: 'credentials'
		});
		expect(normalizeLinkUrl('https://example.com/?ref=1')).toEqual({ ok: false, reason: 'query' });
		expect(normalizeLinkUrl('https://example.com/#top')).toEqual({ ok: false, reason: 'fragment' });
		expect(normalizeLinkUrl('   ')).toEqual({ ok: false, reason: 'invalid' });
		expect(normalizeLinkUrl('not a host')).toEqual({ ok: false, reason: 'invalid' });
	});

	it('requires the site root unless allowSubPath is set', () => {
		expect(normalizeLinkUrl('https://example.com/links')).toEqual({
			ok: false,
			reason: 'subpath'
		});
		expect(normalizeLinkUrl('https://example.com/links/', { allowSubPath: true })).toEqual({
			ok: true,
			url: 'https://example.com/links',
			host: 'example.com'
		});
	});

	it('punycodes IDN hosts (URL does) for both url and host', () => {
		expect(normalizeLinkUrl('https://пример.рф')).toEqual({
			ok: true,
			url: 'https://xn--e1afmkfd.xn--p1ai',
			host: 'xn--e1afmkfd.xn--p1ai'
		});
	});
});
