import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';
import { isMailDeliveryAvailable, isMailDeliveryAvailableLive } from '$lib/server/mail/transport';
import { m } from '$lib/paraglide/messages';
import { getCache } from '$lib/server/cache';
import { rateLimitStrict } from '$lib/server/cache/store';
import { requestAddress } from '$lib/server/security/request-address';
import { clientAddressKey } from '$lib/utils/cidr';

const SIGNUP_RATE_LIMIT = { limit: 5, windowSeconds: 60 * 60 } as const;

export const load: PageServerLoad = (event) => {
	if (event.locals.user) {
		redirect(302, '/admin');
	}
	return { mailConfigured: isMailDeliveryAvailable() };
};

export const actions: Actions = {
	signUp: async (event) => {
		// W6.10: security endpoint, fail-closed, IPv6 aggregated on /64.
		const address = clientAddressKey(requestAddress(event.getClientAddress));
		const rate = await rateLimitStrict(
			getCache(),
			`limits:signup:${address}`,
			SIGNUP_RATE_LIMIT.limit,
			SIGNUP_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) {
			event.setHeaders({ 'retry-after': String(SIGNUP_RATE_LIMIT.windowSeconds) });
			return fail(rate.unavailable ? 503 : 429, {
				message: rate.unavailable ? m.auth_err_unavailable() : m.auth_register_err_rate()
			});
		}
		if (!(await isMailDeliveryAvailableLive())) {
			return fail(503, { message: m.auth_register_mail_unconfigured() });
		}
		const formData = await event.request.formData();
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const confirmPassword = formData.get('confirmPassword')?.toString() ?? '';
		const name = formData.get('name')?.toString() ?? '';

		if (!name || !email || !password || !confirmPassword) {
			return fail(400, { message: 'All fields are required' });
		}

		// W6.3 (C3): informed consent is required and never pre-checked. The
		// checkbox is also `required` in the browser; this is the server gate.
		if (formData.get('privacyConsent') !== 'on') {
			return fail(400, { message: m.auth_register_privacy_required() });
		}

		if (password !== confirmPassword) {
			return fail(400, { message: 'Passwords do not match' });
		}

		if (password.length < 8) {
			return fail(400, { message: 'Password must be at least 8 characters' });
		}

		try {
			await auth.api.signUpEmail({
				body: {
					email,
					password,
					name
				}
			});
		} catch (error) {
			// fail() bypasses handleError, so log here or the SMTP failure is invisible.
			if (!(error instanceof APIError)) console.error('[register] sign-up failed', error);
			if (error instanceof APIError) {
				return fail(400, { message: error.message || 'Registration failed' });
			}
			return fail(500, { message: 'An unexpected error occurred' });
		}

		redirect(302, '/verify-email');
	}
};
