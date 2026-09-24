import { describe, expect, it } from 'vitest';
import {
	SERVE_LOGIN_HEADER,
	isLoopbackAddress,
	isTailscaleAddress,
	isTrustedLogin,
	isTrustedNavigation,
	normalizeAddress,
	parseTrustedLogins,
	resolveIdentity,
	shouldAttemptSignIn
} from './identity';

const TRUSTED = ['guangyiliushan@github'];
const noHeaders = () => new Headers();

/**
 * These cases replace the old e2e "untrusted origin" spec: a spoofed
 * `x-real-ip` header must not resolve to a trusted identity any more
 * (ledger §4.27 洞①), and that branch is unreachable from the browser tests.
 */
describe('normalizeAddress', () => {
	it('unwraps IPv6-mapped IPv4 and brackets', () => {
		expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
		expect(normalizeAddress('[::1]')).toBe('::1');
		expect(normalizeAddress('  127.0.0.1  ')).toBe('127.0.0.1');
		expect(normalizeAddress('')).toBeNull();
		expect(normalizeAddress(null)).toBeNull();
	});
});

describe('address classification', () => {
	it('recognises loopback only', () => {
		for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
			expect(isLoopbackAddress(ip)).toBe(true);
		}
		for (const ip of ['100.117.179.110', '203.0.113.7', '10.0.0.1']) {
			expect(isLoopbackAddress(ip)).toBe(false);
		}
	});

	it('recognises the tailscale CGNAT range 100.64.0.0/10 only', () => {
		for (const ip of ['100.64.0.1', '100.117.179.110', '100.127.255.254']) {
			expect(isTailscaleAddress(ip)).toBe(true);
		}
		for (const ip of ['100.63.255.255', '100.128.0.1', '203.0.113.7', '::1']) {
			expect(isTailscaleAddress(ip)).toBe(false);
		}
	});
});

describe('trusted logins', () => {
	it('parses comma/space separated values case-insensitively', () => {
		expect(parseTrustedLogins('guangyiliushan@github, Admin@Example.com  x@y')).toEqual([
			'guangyiliushan@github',
			'admin@example.com',
			'x@y'
		]);
		expect(parseTrustedLogins(undefined)).toEqual([]);
	});

	it('matches tailnet login names, which are not necessarily emails', () => {
		expect(isTrustedLogin('GuangYiLiuShan@GitHub', TRUSTED)).toBe(true);
		expect(isTrustedLogin('guangyiliushan@gmail.com', TRUSTED)).toBe(false);
		expect(isTrustedLogin(null, TRUSTED)).toBe(false);
	});
});

describe('resolveIdentity', () => {
	const base = { trustedLogins: TRUSTED, allowLoopback: false };

	it('rejects a spoofed x-real-ip over an untrusted address', () => {
		const identity = resolveIdentity({
			...base,
			clientAddress: '203.0.113.7',
			headers: new Headers({
				'x-real-ip': '100.117.179.110',
				[SERVE_LOGIN_HEADER]: 'guangyiliushan@github'
			}),
			whois: () => ({ login: 'guangyiliushan@github', node: 'spoofed' })
		});
		expect(identity).toBeNull();
	});

	it('honours the serve header on loopback, but only for trusted logins', () => {
		expect(
			resolveIdentity({
				...base,
				clientAddress: '127.0.0.1',
				headers: new Headers({ [SERVE_LOGIN_HEADER]: 'GuangYiLiuShan@GitHub' })
			})
		).toEqual({
			kind: 'tailnet',
			source: 'serve-header',
			login: 'guangyiliushan@github',
			node: null
		});

		expect(
			resolveIdentity({
				...base,
				clientAddress: '::1',
				headers: new Headers({ [SERVE_LOGIN_HEADER]: 'stranger@github' })
			})
		).toBeNull();
	});

	it('never trusts a serve header from a non-loopback connection', () => {
		expect(
			resolveIdentity({
				...base,
				clientAddress: '100.117.179.110',
				headers: new Headers({ [SERVE_LOGIN_HEADER]: 'guangyiliushan@github' }),
				whois: () => null
			})
		).toBeNull();
	});

	it('allows plain loopback only when switched on', () => {
		expect(
			resolveIdentity({ ...base, clientAddress: '127.0.0.1', headers: noHeaders() })
		).toBeNull();
		expect(
			resolveIdentity({
				...base,
				allowLoopback: true,
				clientAddress: '127.0.0.1',
				headers: noHeaders()
			})
		).toEqual({ kind: 'local', source: 'loopback', login: null, node: null });
	});

	it('resolves a tailnet peer through whois and enforces the allowlist', () => {
		const whois = () => ({ login: 'guangyiliushan@github', node: 'redmibook14-2023' });

		expect(
			resolveIdentity({ ...base, clientAddress: '100.117.179.110', headers: noHeaders(), whois })
		).toEqual({
			kind: 'tailnet',
			source: 'whois',
			login: 'guangyiliushan@github',
			node: 'redmibook14-2023'
		});

		// "peer not found" (loopback/foreign address or daemon down) fails closed
		expect(
			resolveIdentity({
				...base,
				clientAddress: '100.117.179.110',
				headers: noHeaders(),
				whois: () => null
			})
		).toBeNull();

		expect(
			resolveIdentity({
				...base,
				clientAddress: '100.117.179.110',
				headers: noHeaders(),
				whois: () => ({ login: 'stranger@github', node: null })
			})
		).toBeNull();
	});

	it('honours the dev-only forceLocal escape hatch', () => {
		expect(
			resolveIdentity({
				...base,
				forceLocal: true,
				clientAddress: '203.0.113.7',
				headers: noHeaders()
			})
		).toEqual({ kind: 'local', source: 'loopback', login: null, node: null });
	});
});

describe('shouldAttemptSignIn', () => {
	it('always probes tailnet addresses', () => {
		expect(
			shouldAttemptSignIn({
				clientAddress: '100.117.179.110',
				headers: noHeaders(),
				allowLoopback: false
			})
		).toBe(true);
	});

	it('follows the loopback switch', () => {
		expect(
			shouldAttemptSignIn({
				clientAddress: '127.0.0.1',
				headers: noHeaders(),
				allowLoopback: false
			})
		).toBe(false);
		expect(
			shouldAttemptSignIn({ clientAddress: '127.0.0.1', headers: noHeaders(), allowLoopback: true })
		).toBe(true);
	});

	it('does not probe unrelated addresses even with loopback allowed', () => {
		expect(
			shouldAttemptSignIn({
				clientAddress: '203.0.113.7',
				headers: noHeaders(),
				allowLoopback: true
			})
		).toBe(false);
	});

	it('probes loopback when a serve header is present', () => {
		expect(
			shouldAttemptSignIn({
				clientAddress: '127.0.0.1',
				headers: new Headers({ [SERVE_LOGIN_HEADER]: 'guangyiliushan@github' }),
				allowLoopback: false
			})
		).toBe(true);
	});
});

describe('isTrustedNavigation (GET endpoints that change state)', () => {
	const origin = 'http://localhost:5173';

	it('accepts same-origin and browser-typed navigations', () => {
		expect(isTrustedNavigation(new Headers({ 'sec-fetch-site': 'same-origin' }), origin)).toBe(
			true
		);
		expect(isTrustedNavigation(new Headers({ 'sec-fetch-site': 'none' }), origin)).toBe(true);
		expect(isTrustedNavigation(new Headers({ 'Sec-Fetch-Site': 'SAME-ORIGIN' }), origin)).toBe(
			true
		);
	});

	it('refuses cross-site, same-site and malformed fetch metadata', () => {
		for (const site of ['cross-site', 'same-site', 'nonsense']) {
			expect(isTrustedNavigation(new Headers({ 'sec-fetch-site': site }), origin)).toBe(false);
		}
	});

	it('falls back to a same-origin referer when fetch metadata is absent', () => {
		expect(
			isTrustedNavigation(new Headers({ referer: 'http://localhost:5173/admin' }), origin)
		).toBe(true);
		expect(isTrustedNavigation(new Headers({ referer: 'http://evil.example/admin' }), origin)).toBe(
			false
		);
		expect(isTrustedNavigation(new Headers({ referer: 'not a url' }), origin)).toBe(false);
	});

	it('refuses when neither signal is present (fail closed)', () => {
		expect(isTrustedNavigation(new Headers(), origin)).toBe(false);
		expect(isTrustedNavigation(new Headers({ referer: 'http://localhost:5173/' }), null)).toBe(
			false
		);
	});
});

describe('serve header vs loopback trust', () => {
	const base = { trustedLogins: TRUSTED, allowLoopback: true };

	it('does not fall back to loopback when an untrusted serve header is present', () => {
		expect(
			resolveIdentity({
				...base,
				clientAddress: '127.0.0.1',
				headers: new Headers({ [SERVE_LOGIN_HEADER]: 'stranger@github' })
			})
		).toBeNull();
	});

	it('still allows plain loopback when no serve header is present', () => {
		expect(resolveIdentity({ ...base, clientAddress: '127.0.0.1', headers: noHeaders() })).toEqual({
			kind: 'local',
			source: 'loopback',
			login: null,
			node: null
		});
	});
});
