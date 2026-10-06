import { describe, expect, it } from 'vitest';
import { isSameSite, normalizeHost, redactCredentials, stripWww, urlKey } from './normalize';

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
