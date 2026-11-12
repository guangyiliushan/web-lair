import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, runMock } = vi.hoisted(() => ({
	selectMock: vi.fn(),
	runMock: vi.fn()
}));

vi.mock('$lib/server/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => selectMock()
				})
			})
		})
	}
}));

vi.mock('$lib/server/config/options-registry', () => ({
	getOption: async (key: string) =>
		key === 'friends.checks'
			? {
					enabled: true,
					cadenceHours: 24,
					failStreak: 3,
					backlinkStreak: 2,
					graceDays: 30,
					timeoutMs: 10000,
					concurrency: 2
				}
			: {
					blockedHostSuffixes: [],
					blockedTlds: [],
					acceptedBacklinkHosts: [],
					publicBannedList: true
				}
}));

import { LinkAdminError, precheckLink } from './admin';
import { PrecheckError } from './precheck';

const pendingRow = {
	id: 'link-1',
	url: 'https://example.com',
	host: 'example.com',
	backlinkUrl: 'https://example.com/links',
	status: 'pending'
};

beforeEach(() => {
	selectMock.mockReset();
	runMock.mockReset();
});

describe('precheckLink', () => {
	it('refuses every non-pending status', async () => {
		for (const status of ['approved', 'outdated', 'rejected', 'banned']) {
			selectMock.mockResolvedValue([{ ...pendingRow, status }]);
			await expect(precheckLink('link-1', 'actor', { run: runMock })).rejects.toMatchObject({
				code: 'not-checkable'
			});
		}
		expect(runMock).not.toHaveBeenCalled();
	});

	it('runs the admin precheck for a pending row', async () => {
		selectMock.mockResolvedValue([pendingRow]);
		runMock.mockResolvedValue({ id: 'run-1', status: 'completed' });

		const run = await precheckLink('link-1', 'actor', { run: runMock });

		expect(run).toMatchObject({ id: 'run-1' });
		expect(runMock).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: 'admin',
				actorId: 'actor',
				link: { id: 'link-1', url: 'https://example.com', backlinkUrl: 'https://example.com/links' }
			})
		);
	});

	it('maps precheck conflicts to admin error codes', async () => {
		selectMock.mockResolvedValue([pendingRow]);
		runMock.mockRejectedValue(new PrecheckError('busy'));

		await expect(precheckLink('link-1', 'actor', { run: runMock })).rejects.toBeInstanceOf(
			LinkAdminError
		);
		await expect(precheckLink('link-1', 'actor', { run: runMock })).rejects.toMatchObject({
			code: 'busy'
		});
	});
});
