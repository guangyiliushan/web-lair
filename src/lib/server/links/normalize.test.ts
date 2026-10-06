import { describe, expect, it } from 'vitest';
import { isSameSite, normalizeHost, normalizeUrl, stripWww, urlKey } from './normalize';

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

	it('normalizeUrl: https only, :443 dropped, fragment gone, trailing slash trimmed', () => {
		expect(normalizeUrl('http://example.com/')).toBeNull();
		expect(normalizeUrl('not a url')).toBeNull();
		const result = normalizeUrl('https://WWW.Example.com:443/path/?q=1#frag');
		expect(result).toEqual({
			url: 'https://www.example.com/path?q=1',
			host: 'example.com',
			pathname: '/path'
		});
		expect(normalizeUrl('https://example.com/')?.url).toBe('https://example.com/');
		expect(normalizeUrl('https://example.com')?.pathname).toBe('/');
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
