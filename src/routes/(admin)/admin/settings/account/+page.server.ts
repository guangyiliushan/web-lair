import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';
import { APIError } from 'better-auth/api';
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import {
	account as authAccount,
	passkey as authPasskey,
	session as authSession,
	user
} from '$lib/server/db/auth.schema';
import { requireAdminRole } from '$lib/server/authz';
import { recordActivity } from '$lib/server/audit';
import { settingAccess, assertSettingWrite } from '$lib/server/settings/tiers';
import { getOption } from '$lib/server/config/options-registry';
import { pruneOtherSessions, pruneOtherSessionsKeepingNewest } from '$lib/server/auth/sessions';
import { getAdminConfig } from '$lib/server/config/admin';
import { formatDateTime } from '$lib/utils/i18n';

/** Rows the account page never exposes more of (AC10: token is never sent). */
const SESSION_LIST_LIMIT = 50;

function oauthCallback(origin: string, provider: string): string {
	return new URL(`/api/auth/callback/${provider}`, origin).toString();
}

/** True when the account has a credential row that can verify a password. */
async function hasPasswordCredential(userId: string): Promise<boolean> {
	const rows = await db
		.select({ id: authAccount.id })
		.from(authAccount)
		.where(
			and(
				eq(authAccount.userId, userId),
				eq(authAccount.providerId, 'credential'),
				isNotNull(authAccount.password)
			)
		)
		.limit(1);
	return rows.length > 0;
}

/**
 * Account security audit (AC6/W8.7). Events are two-segment
 * `account.<action>` names, local-only (`deliver: false`) so credential
 * metadata never fans out to webhook subscribers, and payloads carry ids or
 * booleans only - never passwords, tokens, TOTP secrets or backup codes.
 *
 * Best-effort by design: the credential mutation has already succeeded, so a
 * failed audit write is logged rather than turned into a misleading error.
 */
async function recordAccountEvent(
	userId: string | undefined,
	event: string,
	payload: Record<string, unknown> = {}
): Promise<void> {
	if (!userId) return;
	try {
		await recordActivity(db, { event, actorId: userId, payload, deliver: false });
	} catch (error) {
		console.warn(
			`[account] audit ${event} failed:`,
			error instanceof Error ? error.message : error
		);
	}
}

/**
 * B3 (ledger §4.24): TOTP management for the signed-in owner/admin.
 *
 * Shape of the flow (verified against better-auth 1.7.5 dist):
 *   enable   -> stores an *unverified* secret, returns { totpURI, backupCodes[] }
 *   verify   -> the first code flips `verified` and `user.twoFactorEnabled`
 *   disable  -> requires the password, clears both
 *
 * Both verify and disable ROTATE the current session server-side (new row +
 * cookie, old row deleted), which is why the prunes below keep the *newest*
 * session instead of the request token. `enable` and
 * `regenerateBackupCodes` do not rotate, so they prune by token (and `enable`
 * only stages a pending secret - the state change happens on activate).
 *
 * Actions re-check the guard themselves: SvelteKit runs the action before the
 * layout load, so the layout guard cannot protect an action (same pattern as
 * the comment queue).
 */

function errorStatus(caught: APIError): string {
	return String((caught as { status?: unknown }).status ?? '');
}

/** better-auth's machine-readable code (APIError.body.code), when present. */
function errorCode(caught: APIError): string {
	const body = (caught as { body?: { code?: unknown } }).body;
	return typeof body?.code === 'string' ? body.code : '';
}

/**
 * `step` rides along on every failure so the page can keep the user inside the
 * activation flow: without it a failed activation used to drop the rendered
 * secret and force a full re-enable (B3.1 review).
 */
function formError(caught: unknown, fallback: string, step: string, action: string) {
	if (caught instanceof APIError) {
		console.warn(`[2fa] ${action} rejected`, { status: errorStatus(caught) });
		return fail(400, { message: caught.message || fallback, step });
	}
	console.warn(`[2fa] ${action} failed:`, caught instanceof Error ? caught.message : caught);
	return fail(500, { message: fallback, step });
}

export const load: PageServerLoad = async (event) => {
	await requireAdminRole();

	const userId = event.locals.user?.id ?? '';
	const now = new Date();
	const [row, siteTz, sessionRows, passkeyRows, credentialRows] = await Promise.all([
		db.query.user.findFirst({
			where: eq(user.id, userId),
			columns: { twoFactorEnabled: true }
		}),
		getOption('site.timezone'),
		db
			.select({
				id: authSession.id,
				createdAt: authSession.createdAt,
				updatedAt: authSession.updatedAt,
				expiresAt: authSession.expiresAt,
				ipAddress: authSession.ipAddress,
				userAgent: authSession.userAgent
			})
			.from(authSession)
			.where(and(eq(authSession.userId, userId), gt(authSession.expiresAt, now)))
			.orderBy(desc(authSession.updatedAt))
			.limit(SESSION_LIST_LIMIT),
		db
			.select({
				id: authPasskey.id,
				name: authPasskey.name,
				aaguid: authPasskey.aaguid,
				createdAt: authPasskey.createdAt,
				deviceType: authPasskey.deviceType,
				backedUp: authPasskey.backedUp
			})
			.from(authPasskey)
			.where(eq(authPasskey.userId, userId)),
		db
			.select({ id: authAccount.id })
			.from(authAccount)
			.where(
				and(
					eq(authAccount.userId, userId),
					eq(authAccount.providerId, 'credential'),
					isNotNull(authAccount.password)
				)
			)
			.limit(1)
	]);

	const origin = env.ORIGIN || event.url.origin;
	const currentSessionId = event.locals.session?.id ?? null;

	return {
		twoFactorEnabled: Boolean(row?.twoFactorEnabled),
		editable: settingAccess(event.locals.admin?.role, 'account').editable,
		hasPassword: credentialRows.length > 0,
		currentSessionId,
		sessions: sessionRows.map((session) => ({
			id: session.id,
			current: session.id === currentSessionId,
			ipAddress: session.ipAddress ?? null,
			userAgent: session.userAgent ?? null,
			createdLabel: formatDateTime(session.createdAt, { timeZone: siteTz }),
			updatedLabel: formatDateTime(session.updatedAt, { timeZone: siteTz }),
			expiresLabel: formatDateTime(session.expiresAt, { timeZone: siteTz })
		})),
		passkeys: passkeyRows
			.slice()
			.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
			.map((passkey) => ({
				id: passkey.id,
				name: passkey.name ?? null,
				aaguid: passkey.aaguid ?? null,
				deviceType: passkey.deviceType,
				backedUp: passkey.backedUp,
				createdLabel: passkey.createdAt
					? formatDateTime(passkey.createdAt, { timeZone: siteTz })
					: null
			})),
		oauth: {
			github: {
				configured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
				callback: oauthCallback(origin, 'github')
			},
			google: {
				// Google stays planned: env credentials may be staged, but the
				// provider is not registered in auth.ts yet, so the page must not
				// claim a working sign-in method.
				configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
				callback: oauthCallback(origin, 'google')
			}
		}
	};
};

export const actions: Actions = {
	/**
	 * AC10: revoke one session by its database id. The browser never receives a
	 * session token; the server resolves the row for the signed-in user and
	 * passes only that token to better-auth's official endpoint.
	 */
	revokeSession: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'account', 'account.self');
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		const userId = locals.user?.id ?? '';

		if (!id) {
			return fail(400, {
				message: m.admin_settings_account_err_session_not_found(),
				step: 'devices'
			});
		}
		if (id === locals.session?.id) {
			return fail(400, {
				message: m.admin_settings_account_err_session_current(),
				step: 'devices'
			});
		}

		const [row] = await db
			.select({ token: authSession.token })
			.from(authSession)
			.where(and(eq(authSession.id, id), eq(authSession.userId, userId)))
			.limit(1);
		if (!row) {
			return fail(404, {
				message: m.admin_settings_account_err_session_not_found(),
				step: 'devices'
			});
		}

		try {
			await auth.api.revokeSession({ body: { token: row.token }, headers: request.headers });
		} catch (caught) {
			if (caught instanceof APIError) {
				console.warn('[account] revoke session rejected', { status: errorStatus(caught) });
			} else {
				console.warn(
					'[account] revoke session failed:',
					caught instanceof Error ? caught.message : caught
				);
			}
			return fail(500, {
				message: m.admin_settings_account_err_session_action(),
				step: 'devices'
			});
		}

		await recordAccountEvent(userId, 'account.session_revoke', { session_id: id });

		return { message: m.admin_settings_account_msg_session_revoked(), step: 'devices' };
	},
	/** AC2: sign out every session except the request's own cookie. */
	revokeOthers: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'account', 'account.self');

		try {
			await auth.api.revokeOtherSessions({ headers: request.headers });
		} catch (caught) {
			if (caught instanceof APIError) {
				console.warn('[account] revoke other sessions rejected', {
					status: errorStatus(caught)
				});
			} else {
				console.warn(
					'[account] revoke other sessions failed:',
					caught instanceof Error ? caught.message : caught
				);
			}
			return fail(500, {
				message: m.admin_settings_account_err_session_action(),
				step: 'devices'
			});
		}

		await recordAccountEvent(locals.user?.id, 'account.session_revoke_others', {
			kept_session_id: locals.session?.id ?? null
		});

		return { message: m.admin_settings_account_msg_sessions_revoked(), step: 'devices' };
	},

	/** AC2: end the current session and return to the admin sign-in page. */
	signOut: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'account', 'account.self');

		try {
			await auth.api.signOut({ headers: request.headers });
		} catch (caught) {
			console.warn('[account] sign out failed:', caught instanceof Error ? caught.message : caught);
			return fail(500, {
				message: m.admin_settings_account_err_session_action(),
				step: 'devices'
			});
		}

		await recordAccountEvent(locals.user?.id, 'account.session_sign_out');
		redirect(303, getAdminConfig().loginPath);
	},

	/**
	 * AC3: change the account password. better-auth verifies the current
	 * password, rewrites the credential hash and (with
	 * `revokeOtherSessions: true`) replaces every session with a fresh one,
	 * setting the new cookie on this response. `pruneOtherSessionsKeepingNewest`
	 * is the belt-and-braces pass the decision register asks for.
	 */
	changePassword: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'account', 'account.self');
		const form = await request.formData();
		const currentPassword = (form.get('currentPassword') ?? '').toString();
		const newPassword = (form.get('newPassword') ?? '').toString();
		const confirmPassword = (form.get('confirmPassword') ?? '').toString();

		if (!currentPassword) {
			return fail(400, {
				message: m.admin_settings_account_err_password_current_required(),
				step: 'password'
			});
		}
		if (newPassword.length < 8) {
			return fail(400, {
				message: m.admin_settings_account_err_password_new_short(),
				step: 'password'
			});
		}
		if (newPassword.length > 128) {
			return fail(400, {
				message: m.admin_settings_account_err_password_new_long(),
				step: 'password'
			});
		}
		if (newPassword !== confirmPassword) {
			return fail(400, {
				message: m.admin_settings_account_err_password_mismatch(),
				step: 'password'
			});
		}

		try {
			await auth.api.changePassword({
				body: {
					currentPassword,
					newPassword,
					revokeOtherSessions: true
				},
				headers: request.headers
			});
		} catch (caught) {
			if (caught instanceof APIError) {
				const code = errorCode(caught);
				console.warn('[account] change password rejected', { status: errorStatus(caught), code });
				if (code === 'INVALID_PASSWORD') {
					return fail(400, {
						message: m.admin_settings_account_err_password_incorrect(),
						step: 'password'
					});
				}
				if (code === 'CREDENTIAL_ACCOUNT_NOT_FOUND') {
					return fail(400, {
						message: m.admin_settings_account_err_password_unavailable(),
						step: 'password'
					});
				}
			} else {
				console.warn(
					'[account] change password failed:',
					caught instanceof Error ? caught.message : caught
				);
			}
			return fail(500, {
				message: m.admin_settings_account_err_password_failed(),
				step: 'password'
			});
		}

		const userId = locals.user?.id;
		if (userId) {
			await pruneOtherSessionsKeepingNewest(userId);
		}
		await recordAccountEvent(userId, 'account.password_change', {
			revoke_other_sessions: true
		});

		return {
			message: m.admin_settings_account_msg_password_changed(),
			step: 'password'
		};
	},

	/**
	 * AC4: delete one passkey. The last passkey cannot be removed while the
	 * account has no password credential - that would lock the account out.
	 * better-auth's endpoint enforces row ownership; the pre-read gives a
	 * friendly 404 and drives the last-passkey guard.
	 */
	deletePasskey: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'account', 'account.self');
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		const userId = locals.user?.id ?? '';

		if (!id) {
			return fail(400, {
				message: m.admin_settings_account_err_passkey_not_found(),
				step: 'passkey'
			});
		}

		const [row] = await db
			.select({ id: authPasskey.id })
			.from(authPasskey)
			.where(and(eq(authPasskey.id, id), eq(authPasskey.userId, userId)))
			.limit(1);
		if (!row) {
			return fail(404, {
				message: m.admin_settings_account_err_passkey_not_found(),
				step: 'passkey'
			});
		}

		const owned = await db
			.select({ id: authPasskey.id })
			.from(authPasskey)
			.where(eq(authPasskey.userId, userId));
		if (owned.length <= 1 && !(await hasPasswordCredential(userId))) {
			return fail(400, {
				message: m.admin_settings_account_err_passkey_last(),
				step: 'passkey'
			});
		}

		try {
			await auth.api.deletePasskey({ body: { id }, headers: request.headers });
		} catch (caught) {
			console.warn(
				'[account] delete passkey failed:',
				caught instanceof Error ? caught.message : caught
			);
			return fail(500, {
				message: m.admin_settings_account_err_passkey_action(),
				step: 'passkey'
			});
		}

		await recordAccountEvent(userId, 'account.passkey_delete', { passkey_id: id });
		return { message: m.admin_settings_account_msg_passkey_deleted(), step: 'passkey' };
	},

	/** AC4: rename a passkey through the plugin's ownership-checked endpoint. */
	renamePasskey: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'account', 'account.self');
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		const name = (form.get('name') ?? '').toString().trim();
		const userId = locals.user?.id ?? '';

		if (!id) {
			return fail(400, {
				message: m.admin_settings_account_err_passkey_not_found(),
				step: 'passkey'
			});
		}
		if (!name || name.length > 80) {
			return fail(400, {
				message: m.admin_settings_account_err_passkey_name(),
				step: 'passkey'
			});
		}

		const [row] = await db
			.select({ id: authPasskey.id })
			.from(authPasskey)
			.where(and(eq(authPasskey.id, id), eq(authPasskey.userId, userId)))
			.limit(1);
		if (!row) {
			return fail(404, {
				message: m.admin_settings_account_err_passkey_not_found(),
				step: 'passkey'
			});
		}

		try {
			await auth.api.updatePasskey({ body: { id, name }, headers: request.headers });
		} catch (caught) {
			console.warn(
				'[account] rename passkey failed:',
				caught instanceof Error ? caught.message : caught
			);
			return fail(500, {
				message: m.admin_settings_account_err_passkey_action(),
				step: 'passkey'
			});
		}

		await recordAccountEvent(userId, 'account.passkey_rename', { passkey_id: id });
		return { message: m.admin_settings_account_msg_passkey_renamed(), step: 'passkey' };
	},

	/** Step 1: verify the password, receive the secret + one-time backup codes. */
	enable: async (event) => {
		await requireAdminRole();
		const formData = await event.request.formData();
		const password = formData.get('password')?.toString() ?? '';

		if (!password) {
			return fail(400, { message: m.admin_settings_account_err_pw_required(), step: 'enable' });
		}

		try {
			const result = await auth.api.enableTwoFactor({
				body: { password },
				headers: event.request.headers
			});

			// The response is a union: the OTP variant only appears when a sendOTP
			// provider is configured, which this deployment does not have.
			if (!('totpURI' in result)) {
				return fail(400, {
					message: m.admin_settings_account_err_totp_unavailable(),
					step: 'enable'
				});
			}

			console.info('[2fa] enable started (pending activation)', {
				userId: event.locals.user?.id
			});
			await recordAccountEvent(event.locals.user?.id, 'account.two_factor_enable', {
				stage: 'pending'
			});

			return {
				step: 'activate' as const,
				totpURI: result.totpURI,
				backupCodes: result.backupCodes
			};
		} catch (caught) {
			return formError(caught, m.admin_settings_account_err_2fa_start_failed(), 'enable', 'enable');
		}
	},

	/** Step 2: the first valid code activates the factor. */
	activate: async (event) => {
		await requireAdminRole();
		const formData = await event.request.formData();
		const code = formData.get('code')?.toString().trim() ?? '';

		if (!code) {
			return fail(400, { message: m.admin_settings_account_err_code_required(), step: 'activate' });
		}

		try {
			await auth.api.verifyTOTP({ body: { code }, headers: event.request.headers });
		} catch (caught) {
			return formError(
				caught,
				m.admin_settings_account_err_2fa_activate_failed(),
				'activate',
				'activate'
			);
		}

		// The plugin rotated the current session (see the header comment): keep
		// the new one and drop every other session the account still holds.
		const userId = event.locals.user?.id;
		if (userId) {
			await pruneOtherSessionsKeepingNewest(userId);
		}

		console.info('[2fa] activated', { userId });
		await recordAccountEvent(userId, 'account.two_factor_activate');
		return { message: m.admin_settings_account_msg_2fa_enabled(), step: 'done' as const };
	},

	disable: async (event) => {
		await requireAdminRole();
		const formData = await event.request.formData();
		const password = formData.get('password')?.toString() ?? '';

		if (!password) {
			return fail(400, { message: m.admin_settings_account_err_pw_required(), step: 'disable' });
		}

		try {
			await auth.api.disableTwoFactor({
				body: { password },
				headers: event.request.headers
			});
		} catch (caught) {
			return formError(
				caught,
				m.admin_settings_account_err_2fa_disable_failed(),
				'disable',
				'disable'
			);
		}

		// Same rotation as activate: keep the fresh session, drop the rest.
		const userId = event.locals.user?.id;
		if (userId) {
			await pruneOtherSessionsKeepingNewest(userId);
		}

		console.info('[2fa] disabled', { userId });
		await recordAccountEvent(userId, 'account.two_factor_disable');
		return { message: m.admin_settings_account_msg_2fa_disabled(), step: 'done' as const };
	},

	regenerateBackupCodes: async (event) => {
		await requireAdminRole();
		const formData = await event.request.formData();
		const password = formData.get('password')?.toString() ?? '';

		if (!password) {
			return fail(400, { message: m.admin_settings_account_err_pw_required(), step: 'regenerate' });
		}

		try {
			// Password-gated (allowPasswordless is off): the endpoint's body type
			// requires it, and a fresh set of codes invalidates the old ones.
			const result = await auth.api.generateBackupCodes({
				body: { password },
				headers: event.request.headers
			});

			// This endpoint does NOT rotate the session, so the request token is
			// still alive and can be kept precisely. Rotating recovery codes should
			// not leave older sessions behind (B3.1 review).
			const userId = event.locals.user?.id;
			const currentToken = (event.locals.session as { token?: string } | null)?.token;
			if (userId && currentToken) {
				await pruneOtherSessions(userId, currentToken);
			}

			console.info('[2fa] backup codes regenerated', {
				userId,
				count: result.backupCodes.length
			});
			await recordAccountEvent(userId, 'account.two_factor_backup_codes');

			return {
				backupCodes: result.backupCodes,
				message: m.admin_settings_account_msg_backup_codes(),
				step: 'regenerated' as const
			};
		} catch (caught) {
			return formError(
				caught,
				m.admin_settings_account_err_backup_codes_failed(),
				'regenerate',
				'regenerate'
			);
		}
	}
};
