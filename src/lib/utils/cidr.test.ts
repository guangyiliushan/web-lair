import { describe, expect, it } from 'vitest';
import {
	clientAddressKey,
	ipInCidr,
	ipMatchesCidrs,
	isValidCidr,
	parseCidr,
	parseIp
} from './cidr';

/**
 * Parser teeth: the parser decides CIDR blocking and the per-IP bucket key, so
 * malformed input must be rejected (never "guess a host route") and IPv6 must
 * aggregate on /64.
 */
describe('parseIp', () => {
	it('parses dotted IPv4 and rejects out-of-range octets', () => {
		expect(parseIp('192.0.2.1')).toEqual({ version: 4, value: 0xc0000201n });
		expect(parseIp('256.0.0.1')).toBeNull();
		expect(parseIp('1.2.3')).toBeNull();
		expect(parseIp('')).toBeNull();
	});

	it('parses compressed and full IPv6, including mapped IPv4', () => {
		expect(parseIp('2001:db8::1')).not.toBeNull();
		expect(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toEqual(parseIp('2001:db8::1'));
		expect(parseIp('::ffff:192.0.2.1')).toEqual(parseIp('::ffff:c000:201'));
		expect(parseIp('1::2::3')).toBeNull();
		expect(parseIp('12345::1')).toBeNull();
	});
});

describe('parseCidr / ipInCidr', () => {
	it('normalises host bits and accepts a bare address as a host route', () => {
		const cidr = parseCidr('192.0.2.99/24');
		expect(cidr).toEqual({ version: 4, value: 0xc0000200n, prefix: 24 });
		expect(parseCidr('192.0.2.9')).toEqual({ version: 4, value: 0xc0000209n, prefix: 32 });
	});

	it('rejects malformed prefixes and mixed families', () => {
		expect(isValidCidr('192.0.2.0/33')).toBe(false);
		expect(isValidCidr('192.0.2.0/')).toBe(false);
		expect(isValidCidr('2001:db8::/129')).toBe(false);
		expect(isValidCidr('not-an-ip/24')).toBe(false);
		const v4 = parseIp('192.0.2.1');
		const v6 = parseCidr('2001:db8::/32');
		expect(v4 && v6 && ipInCidr(v4, v6)).toBe(false);
	});

	it('matches IPv4 and IPv6 ranges', () => {
		expect(ipMatchesCidrs('192.0.2.55', ['10.0.0.0/8', '192.0.2.0/24'])).toBe(true);
		expect(ipMatchesCidrs('192.0.3.55', ['192.0.2.0/24'])).toBe(false);
		expect(ipMatchesCidrs('2001:db8:1::5', ['2001:db8::/32'])).toBe(true);
		expect(ipMatchesCidrs('2001:db9::5', ['2001:db8::/32'])).toBe(false);
		// Invalid entries never block on their own.
		expect(ipMatchesCidrs('192.0.2.55', ['junk'])).toBe(false);
	});
});

describe('clientAddressKey', () => {
	it('unwraps IPv4-mapped IPv6 to the IPv4 address', () => {
		expect(parseIp('::ffff:192.0.2.1')).toEqual(parseIp('192.0.2.1'));
		expect(parseIp('::ffff:c000:201')).toEqual(parseIp('192.0.2.1'));
		expect(clientAddressKey('::ffff:192.0.2.1')).toBe('4:c0000201');
		expect(clientAddressKey('::ffff:192.0.2.1')).toBe(clientAddressKey('192.0.2.1'));
		expect(ipMatchesCidrs('::ffff:192.0.2.5', ['192.0.2.0/24'])).toBe(true);
		// A real IPv6 loopback stays IPv6 and keeps its own /64 bucket.
		expect(parseIp('::1')?.version).toBe(6);
		expect(clientAddressKey('::1')).toBe('6:0:64');
	});

	it('keeps IPv4 exact and aggregates IPv6 on /64', () => {
		expect(clientAddressKey('192.0.2.1')).toBe('4:c0000201');
		const a = clientAddressKey('2001:db8:1:2::1');
		const b = clientAddressKey('2001:db8:1:2:ffff::9');
		expect(a).toBe(b);
		expect(clientAddressKey('2001:db8:1:3::1')).not.toBe(a);
	});

	it('uses one shared bucket for missing addresses', () => {
		expect(clientAddressKey(null)).toBe('unknown');
		expect(clientAddressKey('garbage')).toBe('unknown');
	});
});
