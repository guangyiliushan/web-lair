import { describe, expect, it } from 'vitest';
import { isCsrfForbidden } from './csrf';

const SELF = 'https://lair.example';

function request(
	method: string,
	headers: Record<string, string> = {},
	url = `${SELF}/zh-cn/subscribe`
): Request {
	return new Request(url, { method, headers });
}

function verdict(headers: Record<string, string> = {}, method = 'POST'): boolean {
	return isCsrfForbidden({ request: request(method, headers), selfOrigin: SELF });
}

/**
 * Parity matrix for SvelteKit 2.70.3's pre-hook check
 * (`runtime/server/respond.js:74-93`). Any drift here is a CSRF regression:
 * `hooks.server.ts` is the only enforcement now that the framework check is
 * disabled for the RFC 8058 one-click endpoint.
 */
describe('CSRF predicate (framework parity)', () => {
	it('allows a same-origin form POST', () => {
		expect(verdict({ origin: SELF, 'content-type': 'application/x-www-form-urlencoded' })).toBe(
			false
		);
	});

	it('allows same-origin multipart and enhanced binary forms', () => {
		expect(verdict({ origin: SELF, 'content-type': 'multipart/form-data; boundary=x' })).toBe(
			false
		);
		expect(verdict({ origin: SELF, 'content-type': 'application/x-sveltekit-formdata' })).toBe(
			false
		);
	});

	it('blocks cross-origin form POSTs', () => {
		expect(
			verdict({
				origin: 'https://evil.example',
				'content-type': 'application/x-www-form-urlencoded'
			})
		).toBe(true);
	});

	it('blocks a missing Origin (mail clients are only exempted by the hook route rule)', () => {
		expect(verdict({ 'content-type': 'application/x-www-form-urlencoded' })).toBe(true);
	});

	it('blocks Origin: null', () => {
		expect(verdict({ origin: 'null', 'content-type': 'multipart/form-data' })).toBe(true);
	});

	it('blocks text/plain, the classic simple-request bypass', () => {
		expect(verdict({ origin: 'https://evil.example', 'content-type': 'text/plain' })).toBe(true);
	});

	it('ignores GET and JSON requests (framework parity; JSON APIs own their auth)', () => {
		expect(verdict({ origin: 'https://evil.example' }, 'GET')).toBe(false);
		expect(verdict({ origin: 'https://evil.example', 'content-type': 'application/json' })).toBe(
			false
		);
	});

	it('matches SvelteKit 2.x for a mutating request with no Content-Type', () => {
		// Kit 3 upgrades this to a block; the upgrade checklist lives in csrf.ts.
		expect(verdict({ origin: 'https://evil.example' })).toBe(false);
	});

	it('honours trusted origins', () => {
		expect(
			isCsrfForbidden({
				request: request('POST', {
					origin: 'https://payments.example',
					'content-type': 'application/x-www-form-urlencoded'
				}),
				selfOrigin: SELF,
				trustedOrigins: ['https://payments.example']
			})
		).toBe(false);
	});
});
