import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W1.6/S3-B: GitHub is reader-only. These tests pin the decision table and the
 * role source (the local row, never the provider profile).
 */
const { limitMock } = vi.hoisted(() => ({ limitMock: vi.fn() }));

vi.mock('$lib/server/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({ limit: limitMock })
			})
		})
	}
}));

import {
	ADMIN_OAUTH_BLOCKED_CODE,
	isBlockedAdminOAuthSignIn,
	isBlockedAdminOAuthSignInForUser,
	validateUserProvisioning
} from './admin-login-policy';

const github = { method: 'oauth', oauth: { providerId: 'github' } };
const google = { method: 'oauth', oauth: { providerId: 'google' } };
const email = { method: 'email-password' };

beforeEach(() => {
	vi.clearAllMocks();
	limitMock.mockResolvedValue([{ role: 'user' }]);
});

describe('isBlockedAdminOAuthSignIn', () => {
	it('blocks GitHub for owner and admin roles', () => {
		expect(isBlockedAdminOAuthSignIn({ source: github, role: 'owner' })).toBe(true);
		expect(isBlockedAdminOAuthSignIn({ source: github, role: 'admin' })).toBe(true);
	});

	it('leaves readers, unknown roles and other providers alone', () => {
		expect(isBlockedAdminOAuthSignIn({ source: github, role: 'user' })).toBe(false);
		expect(isBlockedAdminOAuthSignIn({ source: github, role: null })).toBe(false);
		expect(isBlockedAdminOAuthSignIn({ source: google, role: 'admin' })).toBe(false);
	});

	it('never touches non-OAuth methods', () => {
		expect(isBlockedAdminOAuthSignIn({ source: email, role: 'owner' })).toBe(false);
		expect(isBlockedAdminOAuthSignIn({ source: { method: 'oauth' }, role: 'owner' })).toBe(false);
	});
});

describe('isBlockedAdminOAuthSignInForUser', () => {
	it('reads the role from the local row', async () => {
		limitMock.mockResolvedValueOnce([{ role: 'admin' }]);
		await expect(isBlockedAdminOAuthSignInForUser(github, 'user-1')).resolves.toBe(true);
	});

	it('allows a reader row', async () => {
		limitMock.mockResolvedValueOnce([{ role: 'user' }]);
		await expect(isBlockedAdminOAuthSignInForUser(github, 'user-1')).resolves.toBe(false);
	});

	it('skips the lookup for a brand-new account, other providers and non-OAuth', async () => {
		await expect(isBlockedAdminOAuthSignInForUser(github, undefined)).resolves.toBe(false);
		await expect(isBlockedAdminOAuthSignInForUser(google, 'user-1')).resolves.toBe(false);
		await expect(isBlockedAdminOAuthSignInForUser(email, 'user-1')).resolves.toBe(false);
		expect(limitMock).not.toHaveBeenCalled();
	});
});

describe('validateUserProvisioning', () => {
	it('rejects a GitHub sign-in for an admin with the stable code', async () => {
		limitMock.mockResolvedValueOnce([{ role: 'owner' }]);

		await expect(
			validateUserProvisioning({
				user: { id: 'user-1', email: 'owner@example.com' },
				source: { ...github }
			})
		).resolves.toEqual({
			error: ADMIN_OAUTH_BLOCKED_CODE,
			errorDescription: expect.any(String)
		});
	});

	it('allows a reader and never queries for non-OAuth methods', async () => {
		limitMock.mockResolvedValueOnce([{ role: 'user' }]);
		await expect(
			validateUserProvisioning({ user: { id: 'user-1' }, source: github })
		).resolves.toBeUndefined();

		limitMock.mockClear();
		await expect(
			validateUserProvisioning({ user: { id: 'user-1' }, source: email })
		).resolves.toBeUndefined();
		expect(limitMock).not.toHaveBeenCalled();
	});

	it('fails closed when the role lookup throws', async () => {
		limitMock.mockRejectedValueOnce(new Error('db down'));
		await expect(
			validateUserProvisioning({ user: { id: 'user-1' }, source: github })
		).rejects.toThrow('db down');
	});
});
