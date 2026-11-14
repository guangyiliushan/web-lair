import { fail } from '@sveltejs/kit';
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
import { settingAccess, assertSettingWrite } from '$lib/server/settings/tiers';
import { getOption, OPTION_LANGS } from '$lib/server/config/options-registry';
import { pruneOtherSessions, pruneOtherSessionsKeepingNewest } from '$lib/server/auth/sessions';
import { formatDateTime } from '$lib/utils/i18n';

/** Rows the account page never exposes more of (AC10: token is never sent). */
const SESSION_LIST_LIMIT = 50;

function oauthCallback(origin: string, provider: string): string {
	return new URL(`/api/auth/callback/${provider}`, origin).toString();
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
	const [row, siteTz, siteDefaultLang, sessionRows, passkeyRows, credentialRows] =
		await Promise.all([
			db.query.user.findFirst({
				where: eq(user.id, userId),
				columns: { twoFactorEnabled: true, defaultLang: true }
			}),
			getOption('site.timezone'),
			getOption('site.default_lang'),
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
		defaultLang: row?.defaultLang ?? null,
		siteDefaultLang,
		langs: [...OPTION_LANGS],
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
	 * A4: the language new posts start in. An empty value means "follow the
	 * site default" and is stored as NULL, so changing the site default later
	 * moves every author who never picked one.
	 */
	contentLang: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'account', 'account.self');
		const form = await request.formData();
		const lang = (form.get('lang') ?? '').toString();

		if (lang !== '' && !(OPTION_LANGS as readonly string[]).includes(lang)) {
			return fail(400, {
				message: m.admin_settings_account_err_content_lang(),
				step: 'contentLang'
			});
		}

		await db
			.update(user)
			.set({ defaultLang: lang || null })
			.where(eq(user.id, locals.user?.id ?? ''));

		return { message: m.admin_settings_account_msg_content_lang(), step: 'contentLang' };
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
