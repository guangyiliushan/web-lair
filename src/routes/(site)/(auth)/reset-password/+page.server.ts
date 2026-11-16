import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';
import { m } from '$lib/paraglide/messages';

/** Form-level marker: the link is expired, already used, or forged. */
const INVALID_TOKEN = 'invalid_token';

/**
 * The token arrives as `?token=` after better-auth's callback endpoint
 * (`/api/auth/reset-password/:token`) verified it; an expired or used token comes
 * back with `?error=INVALID_TOKEN`. Both cases render the recovery state — this URL
 * must never answer 404, and a bare visit still needs a path forward.
 */
export const load: PageServerLoad = (event) => {
	// The token is in this URL; strict-origin keeps the path out of Referer.
	event.setHeaders({ 'referrer-policy': 'strict-origin' });
	const token = event.url.searchParams.get('token');
	const rejected = event.url.searchParams.has('error');
	if (!token || rejected) {
		return { state: 'invalid' as const, token: '' };
	}
	return { state: 'form' as const, token };
};

export const actions: Actions = {
	reset: async (event) => {
		const formData = await event.request.formData();
		const token = formData.get('token')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const confirmPassword = formData.get('confirmPassword')?.toString() ?? '';

		if (!token) {
			return fail(400, {
				message: m.auth_reset_err_invalid_token(),
				errorCode: INVALID_TOKEN
			});
		}

		if (!password || !confirmPassword) {
			return fail(400, { message: m.auth_reset_err_required(), errorCode: '' });
		}

		if (password !== confirmPassword) {
			return fail(400, { message: m.auth_reset_err_mismatch(), errorCode: '' });
		}

		if (password.length < 8) {
			return fail(400, { message: m.auth_reset_err_short(), errorCode: '' });
		}

		try {
			// `revokeSessionsOnPasswordReset` (auth.ts) deletes every session of
			// the account, so a stolen cookie cannot outlive the reset.
			await auth.api.resetPassword({
				body: { newPassword: password, token },
				headers: event.request.headers
			});
		} catch (error) {
			if (error instanceof APIError) {
				const code =
					error.body && typeof error.body === 'object' && 'code' in error.body
						? String(error.body.code)
						: '';
				if (code === 'INVALID_TOKEN') {
					console.warn('[reset-password] rejected a token', code);
					return fail(400, {
						message: m.auth_reset_err_invalid_token(),
						errorCode: INVALID_TOKEN
					});
				}
				// Upstream wording (password policy, user lookup) is internal and
				// English-only; the page owns the localized copy.
				console.warn('[reset-password] rejected', code || 'unknown');
				return fail(400, { message: m.auth_reset_err_unexpected(), errorCode: '' });
			}
			console.error('[reset-password] unexpected failure', (error as Error).name);
			return fail(500, { message: m.auth_reset_err_unexpected(), errorCode: '' });
		}

		redirect(303, '/login?message=password-reset-success');
	}
};
