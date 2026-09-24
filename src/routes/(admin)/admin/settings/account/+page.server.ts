import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import { requireAdminRole } from '$lib/server/authz';

/**
 * B3 (ledger §4.24): TOTP management for the signed-in owner/admin.
 *
 * Shape of the flow (verified against better-auth 1.7.5 dist):
 *   enable   -> stores an *unverified* secret, returns { totpURI, backupCodes[] }
 *   verify   -> the first code flips `verified` and `user.twoFactorEnabled`
 *   disable  -> requires the password, clears both
 * Actions re-check the guard themselves: SvelteKit runs the action before the
 * layout load, so the layout guard cannot protect an action (same pattern as
 * the comment queue).
 */

function formError(caught: unknown, fallback: string) {
	if (caught instanceof APIError) {
		return fail(400, { message: caught.message || fallback });
	}
	console.warn('[two-factor] action failed:', caught instanceof Error ? caught.message : caught);
	return fail(500, { message: fallback });
}

export const load: PageServerLoad = async (event) => {
	await requireAdminRole();

	const row = await db.query.user.findFirst({
		where: eq(user.id, event.locals.user?.id ?? ''),
		columns: { twoFactorEnabled: true, email: true }
	});

	return {
		twoFactorEnabled: Boolean(row?.twoFactorEnabled),
		accountEmail: row?.email ?? null
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

			return {
				step: 'activate' as const,
				totpURI: result.totpURI,
				backupCodes: result.backupCodes
			};
		} catch (caught) {
			return formError(caught, 'Could not start two-step verification.');
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
			return { message: 'Two-step verification is enabled.', step: 'done' as const };
		} catch (caught) {
			return formError(caught, 'Could not activate two-step verification.');
		}
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
			return { message: 'Two-step verification is disabled.', step: 'done' as const };
		} catch (caught) {
			return formError(caught, 'Could not disable two-step verification.');
		}
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
			return {
				backupCodes: result.backupCodes,
				message: 'New backup codes generated.',
				step: 'activate' as const
			};
		} catch (caught) {
			return formError(caught, 'Could not regenerate backup codes.');
		}
	}
};
