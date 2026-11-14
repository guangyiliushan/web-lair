import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { ADMIN_OAUTH_BLOCKED_CODE } from '$lib/server/auth/admin-login-policy';
import { safeRedirect } from '$lib/server/safe-redirect';
import { APIError } from 'better-auth/api';
import { getCache } from '$lib/server/cache';
import { rateLimitStrict } from '$lib/server/cache/store';
import { requestAddress } from '$lib/server/security/request-address';
import { clientAddressKey } from '$lib/utils/cidr';
import { m } from '$lib/paraglide/messages';

/** Login budget: 10 attempts per IP per 15 minutes, fail-closed (W6.10). */
const LOGIN_RATE_LIMIT = { limit: 10, windowSeconds: 15 * 60 } as const;

export const load: PageServerLoad = (event) => {
	if (event.locals.user) {
		redirect(302, '/admin');
	}
	const error = event.url.searchParams.get('error');
	// PRG landing spot after a completed reset: the reset action redirects here
	// with `?message=password-reset-success` (W1.4). OAuth failures (W1.6) carry
	// `?error=<code>`; only the admin/GitHub refusal gets its own explanation.
	return {
		resetSuccess: event.url.searchParams.get('message') === 'password-reset-success',
		oauthError: error ? (error === ADMIN_OAUTH_BLOCKED_CODE ? 'admin_blocked' : 'failed') : null
	} as const;
};

export const actions: Actions = {
	signIn: async (event) => {
		// W6.10: credentials endpoint — fail-closed per-IP bucket (IPv6 /64).
		const address = clientAddressKey(requestAddress(event.getClientAddress));
		const rate = await rateLimitStrict(
			getCache(),
			`limits:login:${address}`,
			LOGIN_RATE_LIMIT.limit,
			LOGIN_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) {
			event.setHeaders({ 'retry-after': String(LOGIN_RATE_LIMIT.windowSeconds) });
			return fail(rate.unavailable ? 503 : 429, {
				message: rate.unavailable ? m.auth_err_unavailable() : m.auth_login_err_rate()
			});
		}

		const formData = await event.request.formData();
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const redirectTo = safeRedirect(event.url.searchParams.get('redirectTo'));

		if (!email || !password) {
			return fail(400, { message: 'Email and password are required' });
		}

		try {
			await auth.api.signInEmail({
				body: {
					email,
					password,
					callbackURL: '/auth/verification-success'
				}
			});
		} catch (error) {
			if (error instanceof APIError) {
				return fail(400, { message: error.message || 'Invalid email or password' });
			}
			return fail(500, { message: 'An unexpected error occurred' });
		}

		redirect(302, redirectTo);
	},

	signInSocial: async ({ request }) => {
		const formData = await request.formData();
		const provider = formData.get('provider')?.toString() ?? 'github';
		const rawUrl = formData.get('redirectTo')?.toString();
		const callbackURL = safeRedirect(rawUrl);

		const result = await auth.api.signInSocial({
			body: {
				provider: provider as 'github',
				callbackURL,
				// Failures (including the admin/GitHub refusal in auth.ts) come
				// back to this page with `?error=<code>` instead of the API error
				// page; see the load above for the message mapping.
				errorCallbackURL: '/login'
			}
		});

		if (result.url) {
			redirect(302, result.url);
		}
		return fail(400, { message: 'Social sign-in failed' });
	}
};
