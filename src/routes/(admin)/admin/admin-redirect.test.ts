import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireAdminRole } = vi.hoisted(() => ({ requireAdminRole: vi.fn() }));

vi.mock('$lib/server/authz', () => ({ requireAdminRole }));

import { load } from './+page.server';

beforeEach(() => {
	requireAdminRole.mockReset();
});

describe('/admin entry redirect', () => {
	it('guards first, then redirects to the dashboard', async () => {
		await expect(load({} as never)).rejects.toMatchObject({
			status: 307,
			location: '/admin/dashboard'
		});
		expect(requireAdminRole).toHaveBeenCalledTimes(1);
	});

	it('does not redirect when the guard rejects', async () => {
		requireAdminRole.mockRejectedValueOnce(new Error('denied'));
		await expect(load({} as never)).rejects.toThrow('denied');
	});
});
