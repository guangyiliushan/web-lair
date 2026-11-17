import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'better-auth/api';
import { isRedirect } from '@sveltejs/kit';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Account security route tests. The load must expose only database
 * truth (no tokens, no public keys), and every mutation must call the
 * official better-auth endpoint, keep the session/audit invariants and never
 * echo a secret back to the page.
 */
const { state, dbMock, api, guardMock, sessionsMock, auditMock, getOptionMock } = vi.hoisted(() => {
	const state = {
		userRow: { twoFactorEnabled: false },
		rows: new Map<unknown, unknown[]>(),
		whereCalls: [] as unknown[]
	};
	const api = {
		revokeSession: vi.fn(async () => ({ status: true })),
		revokeOtherSessions: vi.fn(async () => ({ status: true })),
		signOut: vi.fn(async () => ({ success: true })),
		changePassword: vi.fn(async () => ({ token: 'new-token', user: { id: 'user-1' } })),
		deletePasskey: vi.fn(async () => ({ status: true })),
		updatePasskey: vi.fn(async () => ({ passkey: { id: 'pk-1' } })),
		enableTwoFactor: vi.fn(async () => ({
			totpURI: 'otpauth://totp/x?secret=ABC',
			backupCodes: ['code-1', 'code-2']
		})),
		verifyTOTP: vi.fn(async () => ({ token: 'rotated-token' })),
		disableTwoFactor: vi.fn(async () => ({ status: true })),
		generateBackupCodes: vi.fn(async () => ({ backupCodes: ['new-1', 'new-2'] }))
	};
	const dbMock = {
		query: { user: { findFirst: vi.fn(async () => state.userRow) } },
		select: vi.fn(() => {
			const chain: Record<string, unknown> = {};
			let table: unknown;
			chain.from = (value: unknown) => {
				table = value;
				return chain;
			};
			chain.where = (condition: unknown) => {
				state.whereCalls.push(condition);
				return chain;
			};
			chain.orderBy = () => chain;
			chain.limit = async () => state.rows.get(table) ?? [];
			chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
				Promise.resolve(state.rows.get(table) ?? []).then(resolve, reject);
			return chain;
		})
	};
	return {
		state,
		dbMock,
		api,
		guardMock: vi.fn(async () => {}),
		sessionsMock: {
			pruneOtherSessions: vi.fn(async () => {}),
			pruneOtherSessionsKeepingNewest: vi.fn(async () => {})
		},
		auditMock: vi.fn(async () => {}),
		getOptionMock: vi.fn(async () => 'UTC')
	};
});

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/auth', () => ({ auth: { api } }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: guardMock }));
vi.mock('$lib/server/auth/sessions', () => sessionsMock);
vi.mock('$lib/server/audit', () => ({ recordActivity: auditMock }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: getOptionMock }));
vi.mock('$lib/server/config/admin', () => ({
	getAdminConfig: () => ({ loginPath: '/admin/test/login' })
}));
vi.mock('$lib/utils/i18n', () => ({
	formatDateTime: (date: Date) => new Date(date).toISOString()
}));
vi.mock('$env/dynamic/private', () => ({
	env: {
		ORIGIN: 'http://localhost:4173',
		GITHUB_CLIENT_ID: 'github-id',
		GITHUB_CLIENT_SECRET: 'github-secret'
	}
}));

import { actions, load } from './+page.server';
import {
	account as accountTable,
	passkey as passkeyTable,
	session as sessionTable
} from '$lib/server/db/auth.schema';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'en');

const NOW = new Date('2026-11-14T10:00:00.000Z');

function makeEvent(
	fields: Record<string, string> = {},
	options: { userId?: string; sessionId?: string; role?: 'owner' | 'admin' } = {}
) {
	const userId = options.userId ?? 'user-1';
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost:4173/admin/settings/account', {
			method: 'POST',
			body,
			headers: { cookie: 'better-auth.session_token=abc' }
		}),
		url: new URL('http://localhost:4173/admin/settings/account'),
		locals: {
			user: { id: userId, email: 'admin@example.com', role: options.role ?? 'owner' },
			session: { id: options.sessionId ?? 'session-1', token: 'current-token' },
			admin: { userId, role: options.role ?? 'owner' }
		}
	};
}

function callAction(name: string, fields: Record<string, string> = {}, options = {}) {
	const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
	return fn(makeEvent(fields, options) as never);
}

function rows(table: unknown, values: unknown[]) {
	state.rows.set(table, values);
}

const dialect = new PgDialect();
function lastWhere() {
	return dialect.sqlToQuery(state.whereCalls.at(-1) as SQL);
}

function lastAudit() {
	const call = auditMock.mock.calls.at(-1) as unknown as [unknown, Record<string, unknown>];
	return call?.[1];
}

function lastAuditEvent(): string {
	return String((lastAudit() as { event?: unknown } | undefined)?.event ?? '');
}

describe('account security page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.userRow = { twoFactorEnabled: false };
		state.rows = new Map();
		state.whereCalls = [];
		rows(accountTable, [{ id: 'cred-1' }]);
	});

	describe('load', () => {
		it('returns real sessions, passkeys, credential state and OAuth status', async () => {
			rows(sessionTable, [
				{
					id: 'session-1',
					createdAt: NOW,
					updatedAt: new Date('2026-11-14T09:00:00.000Z'),
					expiresAt: new Date('2026-12-14T10:00:00.000Z'),
					ipAddress: '203.0.113.4',
					userAgent: 'Firefox/140'
				},
				{
					id: 'session-2',
					createdAt: nowMinus(1),
					updatedAt: nowMinus(2),
					expiresAt: new Date('2026-12-14T10:00:00.000Z'),
					ipAddress: null,
					userAgent: null
				}
			]);
			rows(passkeyTable, [
				{
					id: 'pk-1',
					name: 'Laptop',
					createdAt: NOW,
					deviceType: 'singleDevice',
					backedUp: false
				}
			]);

			const result = (await load(makeEvent() as never)) as Record<string, unknown>;

			expect(guardMock).toHaveBeenCalledTimes(1);
			expect(result.twoFactorEnabled).toBe(false);
			expect(result.hasPassword).toBe(true);
			expect(result.currentSessionId).toBe('session-1');
			expect(result.sessions).toEqual([
				{
					id: 'session-1',
					current: true,
					ipAddress: '203.0.113.4',
					userAgent: 'Firefox/140',
					createdLabel: NOW.toISOString(),
					updatedLabel: '2026-11-14T09:00:00.000Z',
					expiresLabel: '2026-12-14T10:00:00.000Z'
				},
				{
					id: 'session-2',
					current: false,
					ipAddress: null,
					userAgent: null,
					createdLabel: nowMinus(1).toISOString(),
					updatedLabel: nowMinus(2).toISOString(),
					expiresLabel: '2026-12-14T10:00:00.000Z'
				}
			]);
			expect(result.passkeys).toEqual([
				{
					id: 'pk-1',
					name: 'Laptop',
					deviceType: 'singleDevice',
					backedUp: false,
					createdLabel: NOW.toISOString()
				}
			]);
			expect(JSON.stringify(result)).not.toContain('token');
			expect(JSON.stringify(result)).not.toContain('publicKey');
			expect(result.oauth).toEqual({
				github: {
					configured: true,
					callback: 'http://localhost:4173/api/auth/callback/github'
				},
				google: {
					callback: 'http://localhost:4173/api/auth/callback/google'
				}
			});
		});

		it('reports no password credential when only an OAuth account exists', async () => {
			rows(accountTable, []);
			const result = (await load(makeEvent() as never)) as Record<string, unknown>;
			expect(result.hasPassword).toBe(false);
		});
	});

	describe('devices', () => {
		it('refuses to revoke the current session', async () => {
			const result = await callAction('revokeSession', { id: 'session-1' });
			expect(result).toMatchObject({ status: 400, data: { step: 'devices' } });
			expect(api.revokeSession).not.toHaveBeenCalled();
		});

		it('revokes a session by server-resolved token without returning it', async () => {
			rows(sessionTable, [{ token: 'stored-token' }]);
			const result = await callAction('revokeSession', { id: 'session-2' });

			expect(api.revokeSession).toHaveBeenCalledWith({
				body: { token: 'stored-token' },
				headers: expect.any(Headers)
			});
			expect(result).toEqual({
				message: 'Session revoked.',
				step: 'devices'
			});
			expect(JSON.stringify(result)).not.toContain('stored-token');
			expect(lastAuditEvent()).toBe('account.session_revoke');
			expect(lastAudit()?.payload).toEqual({ session_id: 'session-2' });
			expect(lastAudit()).toMatchObject({ actorId: 'user-1', deliver: false });
			const where = lastWhere();
			expect(where.sql.toLowerCase()).toContain('"session"."user_id"');
			expect(where.params).toContain('user-1');
			expect(where.params).toContain('session-2');
		});

		it('returns 404 for a session id that is not owned by the signed-in user', async () => {
			rows(sessionTable, []);
			const result = await callAction('revokeSession', { id: 'someone-else' });
			expect(result).toMatchObject({ status: 404, data: { step: 'devices' } });
			expect(api.revokeSession).not.toHaveBeenCalled();
		});

		it('signs out every other session through the official endpoint', async () => {
			const result = await callAction('revokeOthers');
			expect(api.revokeOtherSessions).toHaveBeenCalledWith({
				headers: expect.any(Headers)
			});
			expect(result).toMatchObject({ message: 'Other sessions were signed out.', step: 'devices' });
			expect(lastAuditEvent()).toBe('account.session_revoke_others');
			expect(lastAudit()?.payload).toEqual({ kept_session_id: 'session-1' });
		});

		it('signs out the current session and redirects to the admin login page', async () => {
			try {
				await callAction('signOut');
				throw new Error('expected redirect');
			} catch (caught) {
				expect(isRedirect(caught)).toBe(true);
				expect((caught as { location: string }).location).toBe('/admin/test/login');
			}
			expect(api.signOut).toHaveBeenCalledWith({ headers: expect.any(Headers) });
			expect(lastAuditEvent()).toBe('account.session_sign_out');
		});
	});

	describe('password', () => {
		it('requires the current password, a long enough new password and a matching confirmation', async () => {
			expect(await callAction('changePassword', {})).toMatchObject({
				status: 400,
				data: { step: 'password' }
			});
			expect(
				await callAction('changePassword', {
					currentPassword: 'old',
					newPassword: 'short',
					confirmPassword: 'short'
				})
			).toMatchObject({ status: 400, data: { step: 'password' } });
			expect(
				await callAction('changePassword', {
					currentPassword: 'old',
					newPassword: 'long-enough-password',
					confirmPassword: 'different-password'
				})
			).toMatchObject({ status: 400, data: { step: 'password' } });
			expect(api.changePassword).not.toHaveBeenCalled();
		});

		it('maps a wrong current password to a friendly error', async () => {
			api.changePassword.mockRejectedValueOnce(
				APIError.from('BAD_REQUEST', { code: 'INVALID_PASSWORD', message: 'Invalid password' })
			);
			const result = await callAction('changePassword', {
				currentPassword: 'wrong',
				newPassword: 'long-enough-password',
				confirmPassword: 'long-enough-password'
			});
			expect(result).toMatchObject({
				status: 400,
				data: { message: 'The current password is incorrect.', step: 'password' }
			});
			expect(sessionsMock.pruneOtherSessionsKeepingNewest).not.toHaveBeenCalled();
		});

		it('maps a missing credential account to the unavailable error', async () => {
			api.changePassword.mockRejectedValueOnce(
				APIError.from('BAD_REQUEST', {
					code: 'CREDENTIAL_ACCOUNT_NOT_FOUND',
					message: 'Credential account not found'
				})
			);
			const result = await callAction('changePassword', {
				currentPassword: 'old-password',
				newPassword: 'new-password-1',
				confirmPassword: 'new-password-1'
			});
			expect(result).toMatchObject({
				status: 400,
				data: { message: 'This account has no password credential.', step: 'password' }
			});
		});

		it('changes the password with revokeOtherSessions and records a secret-free audit row', async () => {
			const result = await callAction('changePassword', {
				currentPassword: 'old-password',
				newPassword: 'new-password-1',
				confirmPassword: 'new-password-1'
			});

			expect(api.changePassword).toHaveBeenCalledWith({
				body: {
					currentPassword: 'old-password',
					newPassword: 'new-password-1',
					revokeOtherSessions: true
				},
				headers: expect.any(Headers)
			});
			expect(sessionsMock.pruneOtherSessionsKeepingNewest).toHaveBeenCalledWith('user-1');
			expect(result).toMatchObject({
				message: 'Password changed. Other devices were signed out.',
				step: 'password'
			});
			expect(lastAuditEvent()).toBe('account.password_change');
			expect(lastAudit()).toMatchObject({ actorId: 'user-1', deliver: false });
			const payload = JSON.stringify(lastAudit()?.payload ?? {});
			expect(payload).not.toContain('new-password-1');
			expect(payload).not.toContain('old-password');
		});
	});

	describe('passkeys', () => {
		beforeEach(() => {
			rows(passkeyTable, [{ id: 'pk-1' }]);
		});

		it('refuses to delete the last passkey when the account has no password', async () => {
			rows(accountTable, []);
			const result = await callAction('deletePasskey', { id: 'pk-1' });
			expect(result).toMatchObject({
				status: 400,
				data: { message: 'You cannot delete the last passkey while the account has no password.' }
			});
			expect(api.deletePasskey).not.toHaveBeenCalled();
		});

		it('allows deleting one of two passkeys when no password credential exists', async () => {
			rows(passkeyTable, [{ id: 'pk-1' }, { id: 'pk-2' }]);
			rows(accountTable, []);
			const result = await callAction('deletePasskey', { id: 'pk-1' });
			expect(api.deletePasskey).toHaveBeenCalledWith({
				body: { id: 'pk-1' },
				headers: expect.any(Headers)
			});
			expect(result).toMatchObject({ step: 'passkey' });
		});

		it('deletes the last passkey when a password credential exists', async () => {
			const result = await callAction('deletePasskey', { id: 'pk-1' });
			expect(api.deletePasskey).toHaveBeenCalledWith({
				body: { id: 'pk-1' },
				headers: expect.any(Headers)
			});
			expect(result).toMatchObject({ step: 'passkey' });
			expect(lastAuditEvent()).toBe('account.passkey_delete');
			expect(lastAudit()?.payload).toEqual({ passkey_id: 'pk-1' });
		});

		it('rejects an unknown passkey id', async () => {
			rows(passkeyTable, []);
			const result = await callAction('deletePasskey', { id: 'missing' });
			expect(result).toMatchObject({ status: 404, data: { step: 'passkey' } });
		});

		it('validates and saves a passkey name', async () => {
			expect(await callAction('renamePasskey', { id: 'pk-1', name: ' ' })).toMatchObject({
				status: 400,
				data: { step: 'passkey' }
			});
			const result = await callAction('renamePasskey', { id: 'pk-1', name: 'Work laptop' });
			expect(api.updatePasskey).toHaveBeenCalledWith({
				body: { id: 'pk-1', name: 'Work laptop' },
				headers: expect.any(Headers)
			});
			expect(result).toMatchObject({ step: 'passkey' });
			expect(lastAuditEvent()).toBe('account.passkey_rename');
		});
	});

	describe('two-factor', () => {
		it('records an audit row without the secret or backup codes', async () => {
			const result = await callAction('enable', { password: 'current-password' });
			expect(result).toMatchObject({ step: 'activate', backupCodes: ['code-1', 'code-2'] });
			expect(lastAuditEvent()).toBe('account.two_factor_enable');
			expect(lastAudit()).toMatchObject({ actorId: 'user-1', deliver: false });
			const payload = JSON.stringify(lastAudit()?.payload ?? {});
			expect(payload).not.toContain('ABC');
			expect(payload).not.toContain('code-1');
		});

		it('does not log the raw failure message (which may embed DB parameters)', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			api.enableTwoFactor.mockRejectedValueOnce(new Error('insert failed: secret ABC'));
			await callAction('enable', { password: 'current-password' });
			expect(JSON.stringify(warn.mock.calls)).not.toContain('ABC');
			warn.mockRestore();
		});

		it('activates and disables the factor, keeping the audit trail', async () => {
			await callAction('activate', { code: '123456' });
			expect(api.verifyTOTP).toHaveBeenCalledWith(
				expect.objectContaining({ body: { code: '123456' } })
			);
			expect(sessionsMock.pruneOtherSessionsKeepingNewest).toHaveBeenCalledWith('user-1');
			expect(lastAuditEvent()).toBe('account.two_factor_activate');

			await callAction('disable', { password: 'current-password' });
			expect(api.disableTwoFactor).toHaveBeenCalled();
			expect(lastAuditEvent()).toBe('account.two_factor_disable');

			const regenerated = await callAction('regenerateBackupCodes', {
				password: 'current-password'
			});
			expect(regenerated).toMatchObject({ backupCodes: ['new-1', 'new-2'], step: 'regenerated' });
			expect(lastAuditEvent()).toBe('account.two_factor_backup_codes');
			expect(JSON.stringify(lastAudit()?.payload ?? {})).not.toContain('new-1');
		});
	});

	it('uses only two-segment account event names accepted by the activities CHECK', async () => {
		rows(sessionTable, [{ token: 'stored-token' }]);
		rows(passkeyTable, [{ id: 'pk-1' }]);
		await callAction('revokeSession', { id: 'session-2' });
		await callAction('revokeOthers');
		try {
			await callAction('signOut');
		} catch (caught) {
			expect(isRedirect(caught)).toBe(true);
		}
		await callAction('changePassword', {
			currentPassword: 'old-password',
			newPassword: 'new-password-1',
			confirmPassword: 'new-password-1'
		});
		await callAction('deletePasskey', { id: 'pk-1' });
		await callAction('renamePasskey', { id: 'pk-1', name: 'Laptop' });
		await callAction('enable', { password: 'current-password' });
		await callAction('activate', { code: '123456' });
		await callAction('disable', { password: 'current-password' });
		await callAction('regenerateBackupCodes', { password: 'current-password' });

		const events = (auditMock.mock.calls as unknown[][]).map(
			(call) => (call[1] as { event: string }).event
		);
		expect(events.slice().sort()).toEqual([
			'account.passkey_delete',
			'account.passkey_rename',
			'account.password_change',
			'account.session_revoke',
			'account.session_revoke_others',
			'account.session_sign_out',
			'account.two_factor_activate',
			'account.two_factor_backup_codes',
			'account.two_factor_disable',
			'account.two_factor_enable'
		]);
		for (const event of events) {
			expect(event).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
		}
	});
});

function nowMinus(minutes: number): Date {
	return new Date(NOW.getTime() - minutes * 60_000);
}
