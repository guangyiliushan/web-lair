import { describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns', () => ({ promises: { lookup: lookupMock } }));

import { isPrivateAddress, pinnedLookup, resolvePublicAddresses } from './ssrf-guard';

const PUBLIC = { address: '93.184.216.34', family: 4 };
const PRIVATE = { address: '127.0.0.1', family: 4 };

describe('ssrf-guard (§4.2 core - direct teeth, review round 4)', () => {
	it('resolvePublicAddresses fails closed on any private / empty answer', async () => {
		lookupMock.mockResolvedValue([PUBLIC, PRIVATE]);
		expect(await resolvePublicAddresses('mixed.example')).toBeNull();

		lookupMock.mockResolvedValue([PRIVATE]);
		expect(await resolvePublicAddresses('private.example')).toBeNull();

		lookupMock.mockResolvedValue([]);
		expect(await resolvePublicAddresses('empty.example')).toBeNull();

		lookupMock.mockResolvedValue([PUBLIC]);
		expect(await resolvePublicAddresses('public.example')).toEqual([PUBLIC]);
	});

	it('pinnedLookup answers from the validated set only', () => {
		const allCb = vi.fn();
		pinnedLookup([PUBLIC, PRIVATE])('host.example', { all: true }, allCb);
		expect(allCb).toHaveBeenCalledWith(null, [PUBLIC, PRIVATE]);

		const oneCb = vi.fn();
		pinnedLookup([PUBLIC])('host.example', undefined, oneCb);
		expect(oneCb).toHaveBeenCalledWith(null, '93.184.216.34', 4);

		const errCb = vi.fn();
		pinnedLookup([])('host.example', undefined, errCb);
		expect(errCb.mock.calls[0][0]).toBeInstanceOf(Error);
	});

	it('unparsable input fails closed and the blocked ranges hold', () => {
		for (const address of [
			'not-an-ip',
			'',
			'::7f00:1',
			'::ffff:7f00:1',
			'64:ff9b:1::7f00:1',
			'fec0::1',
			'2001:2::1',
			'100::1'
		]) {
			expect(isPrivateAddress(address), address).toBe(true);
		}
		expect(isPrivateAddress('93.184.216.34')).toBe(false);
		expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
	});
});
