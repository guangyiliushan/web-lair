import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	can,
	hasAnyAdminCapability,
	requireAdminRole,
	requireAdminWorkspace,
	requireCommentReviewer
} from './authz';

/**
 * Guard / capability boundary tests for the B2 admin surface (B2.1 review fix,
 * T1 + T6). Everything runs in-process: the request event and the auth API are
 * mocked, no database is involved.
 */

const { getRequestEventMock, hasPermissionMock } = vi.hoisted(() => ({
	getRequestEventMock: vi.fn(),
	hasPermissionMock: vi.fn()
}));

vi.mock('$app/server', () => ({ getRequestEvent: getRequestEventMock }));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { hasPermission: hasPermissionMock } }
}));
vi.mock('$lib/server/config/admin', () => ({
	ADMIN_BASE_PATH: '/admin',
	getAdminConfig: () => ({ loginPath: '/admin/secure-abc123/login', setupToken: 'x' })
}));
vi.mock('$lib/server/auth/owner', () => ({
	isAdminRole: (value: unknown) => value === 'owner' || value === 'admin'
}));

const OWNER = { id: 'u-owner', role: 'owner', emailVerified: true };
const REVIEWER = { id: 'u-reviewer', role: 'user', emailVerified: true };

function makeEvent(pathname: string, user: unknown = undefined, session: unknown = undefined) {
	const url = new URL(`http://localhost${pathname}`);
	return {
		locals: { user, session },
		url,
		request: new Request(url)
	};
}

beforeEach(() => {
	getRequestEventMock.mockReset();
	hasPermissionMock.mockReset();
});

describe('can (comment capabilities)', () => {
	it('returns true only when the plugin says success', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin/comments', REVIEWER, {}));
		hasPermissionMock.mockResolvedValueOnce({ success: true });
		await expect(can.reviewComment()).resolves.toBe(true);
		// the memo is per request: a new event asks the plugin again
		getRequestEventMock.mockReturnValue(makeEvent('/admin/comments', REVIEWER, {}));
		hasPermissionMock.mockResolvedValueOnce({ error: null, success: false });
		await expect(can.reviewComment()).resolves.toBe(false);
	});

	it('fails closed when the plugin throws', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin/comments', REVIEWER, {}));
		hasPermissionMock.mockRejectedValueOnce(new Error('no active organization'));
		await expect(can.reviewComment()).resolves.toBe(false);
	});

	it('memoises per request and action set', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin/comments', REVIEWER, {}));
		hasPermissionMock.mockResolvedValue({ success: true });
		await can.reviewComment();
		await can.reviewComment();
		await can.approveComment();
		await can.approveComment();
		expect(hasPermissionMock).toHaveBeenCalledTimes(2);
	});
});

describe('hasAnyAdminCapability', () => {
	it('admits site roles without asking the plugin', async () => {
		await expect(hasAnyAdminCapability(OWNER)).resolves.toBe(true);
		expect(hasPermissionMock).not.toHaveBeenCalled();
	});

	it('falls back to the comment capability for roleless users', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin', REVIEWER, {}));
		hasPermissionMock.mockResolvedValueOnce({ success: true });
		await expect(hasAnyAdminCapability(REVIEWER)).resolves.toBe(true);
		getRequestEventMock.mockReturnValue(makeEvent('/admin', REVIEWER, {}));
		hasPermissionMock.mockResolvedValueOnce({ success: false });
		await expect(hasAnyAdminCapability(REVIEWER)).resolves.toBe(false);
	});
});

describe('requireCommentReviewer', () => {
	it('redirects to the login page without a session', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin/comments'));
		const thrown = await requireCommentReviewer().catch((e) => e);
		expect(thrown.status).toBe(303);
		expect(thrown.location).toContain('/admin/secure-abc123/login');
	});

	it('403s a signed-in user without the capability', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin/comments', REVIEWER, {}));
		hasPermissionMock.mockResolvedValue({ success: false });
		const thrown = await requireCommentReviewer().catch((e) => e);
		expect(thrown.status).toBe(403);
	});

	it('returns the user when the capability is present', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin/comments', REVIEWER, {}));
		hasPermissionMock.mockResolvedValue({ success: true });
		await expect(requireCommentReviewer()).resolves.toBe(REVIEWER);
	});
});

describe('requireAdminWorkspace / requireAdminRole', () => {
	it('keeps roleless capability holders on the queue path', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin/comments', REVIEWER, {}));
		hasPermissionMock.mockResolvedValue({ success: true });
		await expect(requireAdminWorkspace()).resolves.toBeUndefined();
	});

	it('sends roleless capability holders from other pages to the queue', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin/posts/edit', REVIEWER, {}));
		hasPermissionMock.mockResolvedValue({ success: true });
		const thrown = await requireAdminRole().catch((e) => e);
		expect(thrown.status).toBe(303);
		expect(thrown.location).toBe('/admin/comments');
	});

	it('sends users without any capability back to login', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin', REVIEWER, {}));
		hasPermissionMock.mockResolvedValue({ success: false });
		const thrown = await requireAdminRole().catch((e) => e);
		expect(thrown.status).toBe(303);
		expect(thrown.location).toContain('/admin/secure-abc123/login');
	});

	it('admits owner/admin without asking the plugin', async () => {
		getRequestEventMock.mockReturnValue(makeEvent('/admin', OWNER, {}));
		await expect(requireAdminRole()).resolves.toBeUndefined();
		expect(hasPermissionMock).not.toHaveBeenCalled();
	});
});
