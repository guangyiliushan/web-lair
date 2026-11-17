import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GitHub is reader-only. These tests pin the decision table, the
 * lookup source (the local row, by user id) and the fail-closed behaviour.
 */
const { findUserByIdMock } = vi.hoisted(() => ({ findUserByIdMock: vi.fn() }));

import {
	ADMIN_OAUTH_BLOCKED_CODE,
	isBlockedAdminOAuthSignIn,
	isBlockedAdminOAuthSignInForUser,
	validateUserProvisioning,
	type UserLookupContext
} from './admin-login-policy';

const context: UserLookupContext = {
	context: { internalAdapter: { findUserById: findUserByIdMock } }
};

const github = { method: 'oauth', oauth: { providerId: 'github' } };
const google = { method: 'oauth', oauth: { providerId: 'google' } };
const email = { method: 'email-password' };

beforeEach(() => {
	vi.clearAllMocks();
	findUserByIdMock.mockResolvedValue({ id: 'user-1', role: 'user' });
	vi.spyOn(console, 'warn').mockImplementation(() => {});
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
	it('reads the role from the local row by user id', async () => {
		findUserByIdMock.mockResolvedValueOnce({ id: 'user-1', role: 'admin' });

		await expect(isBlockedAdminOAuthSignInForUser(context, github, 'user-1')).resolves.toBe(true);
		// The provider profile never supplies the role; the id is the only input.
		expect(findUserByIdMock).toHaveBeenCalledWith('user-1');
	});

	it('allows a reader row and a missing row (new account)', async () => {
		findUserByIdMock.mockResolvedValueOnce({ id: 'user-1', role: 'user' });
		await expect(isBlockedAdminOAuthSignInForUser(context, github, 'user-1')).resolves.toBe(false);

		findUserByIdMock.mockResolvedValueOnce(null);
		await expect(isBlockedAdminOAuthSignInForUser(context, github, 'user-2')).resolves.toBe(false);
	});

	it('skips the lookup for a brand-new account, other providers and non-OAuth', async () => {
		await expect(isBlockedAdminOAuthSignInForUser(context, github, undefined)).resolves.toBe(false);
		await expect(isBlockedAdminOAuthSignInForUser(context, google, 'user-1')).resolves.toBe(false);
		await expect(isBlockedAdminOAuthSignInForUser(context, email, 'user-1')).resolves.toBe(false);
		expect(findUserByIdMock).not.toHaveBeenCalled();
	});
});

describe('validateUserProvisioning', () => {
	it('rejects a GitHub sign-in for an admin with the stable code and a log line', async () => {
		findUserByIdMock.mockResolvedValueOnce({ id: 'user-1', role: 'owner' });
		const warn = vi.mocked(console.warn);

		await expect(
			validateUserProvisioning(
				{ user: { id: 'user-1', email: 'owner@example.com' }, source: github },
				context
			)
		).resolves.toEqual({
			error: ADMIN_OAUTH_BLOCKED_CODE,
			errorDescription: expect.any(String)
		});
		expect(warn).toHaveBeenCalledWith('[auth] admin GitHub sign-in blocked', {
			userId: 'user-1'
		});
	});

	it('allows a reader and never queries for non-OAuth methods', async () => {
		findUserByIdMock.mockResolvedValueOnce({ id: 'user-1', role: 'user' });
		await expect(
			validateUserProvisioning({ user: { id: 'user-1' }, source: github }, context)
		).resolves.toBeUndefined();

		findUserByIdMock.mockClear();
		await expect(
			validateUserProvisioning({ user: { id: 'user-1' }, source: email }, context)
		).resolves.toBeUndefined();
		expect(findUserByIdMock).not.toHaveBeenCalled();
	});

	it('fails closed when the lookup throws', async () => {
		findUserByIdMock.mockRejectedValueOnce(new Error('db down'));
		await expect(
			validateUserProvisioning({ user: { id: 'user-1' }, source: github }, context)
		).rejects.toThrow('db down');
	});
});
