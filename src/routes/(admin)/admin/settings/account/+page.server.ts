import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import { requireAdminRole } from '$lib/server/authz';
import { pruneOtherSessions, pruneOtherSessionsKeepingNewest } from '$lib/server/auth/sessions';

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

	const row = await db.query.user.findFirst({
		where: eq(user.id, event.locals.user?.id ?? ''),
		columns: { twoFactorEnabled: true }
	});

	return {
		twoFactorEnabled: Boolean(row?.twoFactorEnabled)
	};
};

export const actions: Actions = {
	/** Step 1: verify the password, receive the secret + one-time backup codes. */
	enable: async (event) => {
		await requireAdminRole();
		const formData = await event.request.formData();
		const password = formData.get('password')?.toString() ?? '';

		if (!password) {
			return fail(400, { message: 'Password is required.', step: 'enable' });
		}

		try {
			const result = await auth.api.enableTwoFactor({
				body: { password },
				headers: event.request.headers
			});

			// The response is a union: the OTP variant only appears when a sendOTP
			// provider is configured, which this deployment does not have.
			if (!('totpURI' in result)) {
				return fail(400, { message: 'TOTP is not available on this server.', step: 'enable' });
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
			return formError(caught, 'Could not start two-step verification.', 'enable', 'enable');
		}
	},

	/** Step 2: the first valid code activates the factor. */
	activate: async (event) => {
		await requireAdminRole();
		const formData = await event.request.formData();
		const code = formData.get('code')?.toString().trim() ?? '';

		if (!code) {
			return fail(400, { message: 'Enter the 6-digit code.', step: 'activate' });
		}

		try {
			await auth.api.verifyTOTP({ body: { code }, headers: event.request.headers });
		} catch (caught) {
			return formError(caught, 'Could not activate two-step verification.', 'activate', 'activate');
		}

		// The plugin rotated the current session (see the header comment): keep
		// the new one and drop every other session the account still holds.
		const userId = event.locals.user?.id;
		if (userId) {
			await pruneOtherSessionsKeepingNewest(userId);
		}

		console.info('[2fa] activated', { userId });
		return { message: 'Two-step verification is enabled.', step: 'done' as const };
	},

	disable: async (event) => {
		await requireAdminRole();
		const formData = await event.request.formData();
		const password = formData.get('password')?.toString() ?? '';

		if (!password) {
			return fail(400, { message: 'Password is required.', step: 'disable' });
		}

		try {
			await auth.api.disableTwoFactor({
				body: { password },
				headers: event.request.headers
			});
		} catch (caught) {
			return formError(caught, 'Could not disable two-step verification.', 'disable', 'disable');
		}

		// Same rotation as activate: keep the fresh session, drop the rest.
		const userId = event.locals.user?.id;
		if (userId) {
			await pruneOtherSessionsKeepingNewest(userId);
		}

		console.info('[2fa] disabled', { userId });
		return { message: 'Two-step verification is disabled.', step: 'done' as const };
	},

	regenerateBackupCodes: async (event) => {
		await requireAdminRole();
		const formData = await event.request.formData();
		const password = formData.get('password')?.toString() ?? '';

		if (!password) {
			return fail(400, { message: 'Password is required.', step: 'regenerate' });
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
				message: 'New backup codes generated.',
				step: 'regenerated' as const
			};
		} catch (caught) {
			return formError(caught, 'Could not regenerate backup codes.', 'regenerate', 'regenerate');
		}
	}
};
