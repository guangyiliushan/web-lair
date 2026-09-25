import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'better-auth/api';

const { verifyTotpMock, verifyBackupMock, pruneMock, revokeMock, roleMock, memberMock } =
	vi.hoisted(() => ({
		verifyTotpMock: vi.fn(),
		verifyBackupMock: vi.fn(),
		pruneMock: vi.fn(),
		revokeMock: vi.fn(),
		roleMock: vi.fn(),
		memberMock: vi.fn()
	}));

vi.mock('$lib/server/auth', () => ({
	auth: {
		api: {
			verifyTOTP: verifyTotpMock,
			verifyBackupCode: verifyBackupMock
		}
	}
}));
vi.mock('$lib/server/auth/sessions', () => ({
	pruneOtherSessions: pruneMock,
	revokeSessionByToken: revokeMock
}));
vi.mock('$lib/server/authz', () => ({ getUserRole: roleMock }));
vi.mock('$lib/server/auth/site-organization', () => ({
	isSiteOrganizationMember: memberMock
}));
vi.mock('$lib/server/config/admin', () => ({
	ADMIN_BASE_PATH: '/admin',
	assertAdminSlug: () => ({
		loginPath: '/admin/test-slug/login',
		loginSlug: 'test-slug',
		twoFactorPath: '/admin/test-slug/two-factor',
		setupToken: ''
	})
}));

import { actions } from './+page.server';

type VerifyAction = NonNullable<typeof actions.verify>;

function makeEvent(options: { code?: string; method?: string; challengeCookie?: boolean } = {}) {
	const body = new FormData();
	if (options.code !== undefined) body.set('code', options.code);
	body.set('method', options.method ?? 'totp');
	body.set('redirectTo', '/admin');

	return {
		params: { adminSlug: 'test-slug' },
		request: new Request('http://localhost/admin/test-slug/two-factor', {
			method: 'POST',
			body
		}),
		cookies: {
			getAll: () =>
				options.challengeCookie === false
					? []
					: [{ name: 'better-auth.two_factor', value: 'challenge' }]
		},
		url: new URL('http://localhost/admin/test-slug/two-factor')
	};
}

function callVerify(event: ReturnType<typeof makeEvent>) {
	return (actions.verify as VerifyAction)(event as never);
}

async function callVerifyCatching(event: ReturnType<typeof makeEvent>) {
	try {
		const result = await callVerify(event);
		return { result, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

describe('two-factor verify action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
	});

	it('rejects an empty code with a form message', async () => {
		const result = await callVerify(makeEvent({ code: '' }));
		expect(result).toMatchObject({ status: 400 });
		expect((result as { data?: { message?: string } }).data?.message).toBeTruthy();
	});

	it('classifies a rejected code with a live challenge cookie as invalid_code', async () => {
		// The plugin throws APIError.from(status, "<string>"), whose runtime shape
		// is message === '' / body === {}; the object form below is the typed
		// equivalent of that shape.
		verifyTotpMock.mockRejectedValue(
			APIError.from('UNAUTHORIZED', { message: '', code: 'INVALID_CODE' })
		);

		const result = await callVerify(makeEvent({ code: '123456' }));
		expect(result).toMatchObject({ status: 400, data: { errorCode: 'invalid_code' } });
	});

	it('classifies UNAUTHORIZED without the challenge cookie as expired', async () => {
		verifyTotpMock.mockRejectedValue(
			APIError.from('UNAUTHORIZED', { message: '', code: 'INVALID_TWO_FACTOR_COOKIE' })
		);

		const result = await callVerify(makeEvent({ code: '123456', challengeCookie: false }));
		expect(result).toMatchObject({ status: 400, data: { errorCode: 'expired' } });
	});

	it('maps the account lockout to 429 + locked', async () => {
		verifyTotpMock.mockRejectedValue(
			APIError.from('TOO_MANY_REQUESTS', { message: '', code: 'ACCOUNT_TEMPORARILY_LOCKED' })
		);

		const result = await callVerify(makeEvent({ code: '123456' }));
		expect(result).toMatchObject({ status: 429, data: { errorCode: 'locked' } });
	});

	it('revokes the fresh session when the account is not admitted', async () => {
		verifyTotpMock.mockResolvedValue({
			token: 'fresh-token',
			user: { id: 'user-1', emailVerified: true }
		});
		roleMock.mockReturnValue(null);
		memberMock.mockResolvedValue(false);

		const result = await callVerify(makeEvent({ code: '123456' }));
		expect(result).toMatchObject({ status: 403 });
		expect(revokeMock).toHaveBeenCalledWith('fresh-token');
		expect(pruneMock).not.toHaveBeenCalled();
	});

	it('prunes other sessions and redirects for an admitted account', async () => {
		verifyTotpMock.mockResolvedValue({
			token: 'fresh-token',
			user: { id: 'user-1', emailVerified: true }
		});
		roleMock.mockReturnValue('admin');

		const { thrown } = await callVerifyCatching(makeEvent({ code: '123456' }));
		expect(pruneMock).toHaveBeenCalledWith('user-1', 'fresh-token');
		expect((thrown as { status?: number; location?: string }).status).toBe(302);
		expect((thrown as { status?: number; location?: string }).location).toBe('/admin');
	});

	it('still redirects (with a log) when the plugin returns no session token', async () => {
		verifyTotpMock.mockResolvedValue({ user: { id: 'user-1', emailVerified: true } });
		roleMock.mockReturnValue('admin');

		const { thrown } = await callVerifyCatching(makeEvent({ code: '123456' }));
		expect((thrown as { status?: number }).status).toBe(302);
		expect(pruneMock).not.toHaveBeenCalled();
	});
});
