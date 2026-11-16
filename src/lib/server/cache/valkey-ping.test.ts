import { describe, expect, it, vi } from 'vitest';

const { pingMock } = vi.hoisted(() => ({ pingMock: vi.fn(async () => 'PONG') }));

vi.mock('iovalkey', () => ({
	default: class {
		status = 'ready';
		on(): void {}
		ping = pingMock;
		quit = async (): Promise<'OK'> => 'OK';
	}
}));

import { ValkeyCacheStore } from './valkey';

/**
 * `/api/ready` trusts `CacheStore.ping()` to tell it whether Valkey is up
 * (M6 P4). The route tests mock the cache away, so this is the only place the
 * real implementation runs: a stub `async ping() {}` in `ValkeyCacheStore`
 * would make readiness green with a dead Valkey and nothing else would notice.
 */
describe('ValkeyCacheStore.ping', () => {
	it('resolves on PONG and surfaces a failure instead of swallowing it', async () => {
		const store = new ValkeyCacheStore('redis://127.0.0.1:6379');
		await expect(store.ping()).resolves.toBeUndefined();

		pingMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(store.ping()).rejects.toThrow('ECONNREFUSED');
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
