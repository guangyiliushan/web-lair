import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';
import { m } from '$lib/paraglide/messages';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { requestAddress } from '$lib/server/security/request-address';
import { isMailDeliveryAvailable, isMailDeliveryAvailableLive } from '$lib/server/mail/transport';

/**
 * W1.4 (settings-truth plan, P0-4): a real reset request.
 *
 * better-auth owns the token (verification row `reset-password:<token>`, one
 * hour) and the mail body; this action only hands the request to
 * `requestPasswordReset`, which resolves the address and calls the
 * `sendResetPassword` callback configured in `auth.ts`.
 *
 * The answer is identical for known and unknown addresses (better-auth already
 * fakes the lookup to blunt timing), so the form cannot be used as an account
 * oracle. The one distinguishable failure is a transport that cannot deliver
 * mail at all - that is a site-wide condition, not an account fact.
 */
export const load: PageServerLoad = () => {
	return { mailConfigured: isMailDeliveryAvailable() };
};

export const actions: Actions = {
	sendReset: async (event) => {
		const address = requestAddress(event.getClientAddress);
		const rate = await rateLimit(getCache(), `limits:password-reset:${address}`, 5, 60 * 60);
		if (!rate.allowed) return fail(429, { message: m.auth_forgot_err_rate() });

		const formData = await event.request.formData();
		const email = formData.get('email')?.toString().trim() ?? '';

		if (!email) {
			return fail(400, { message: m.auth_forgot_err_email() });
		}

		// Same gate as sign-up: without a working SMTP handshake the link can
		// never arrive, so do not pretend a mail was sent.
		if (!(await isMailDeliveryAvailableLive())) {
			return fail(503, { message: m.auth_forgot_mail_unconfigured() });
		}

		try {
			await auth.api.requestPasswordReset({
				body: { email, redirectTo: '/reset-password' },
				headers: event.request.headers
			});
		} catch (error) {
			// Anti-enumeration: the transport may fail, the account lookup may be
			// rejected, but the answer stays "check your inbox". Keep the cause in
			// the log - a silent 200 with no mail is the worst failure mode.
			if (error instanceof APIError) {
				console.warn('[forgot-password] reset request rejected', error.message);
			} else {
				console.error('[forgot-password] reset request failed', error);
			}
		}

		return { success: true };
	}
};
