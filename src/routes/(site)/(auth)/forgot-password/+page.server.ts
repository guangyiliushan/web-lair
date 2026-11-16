import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';
import { m } from '$lib/paraglide/messages';
import { getCache } from '$lib/server/cache';
import { rateLimitStrict } from '$lib/server/cache/store';
import { requestAddress } from '$lib/server/security/request-address';
import { clientAddressKey } from '$lib/utils/cidr';
import { isMailDeliveryAvailable, isMailDeliveryAvailableLive } from '$lib/server/mail/transport';
import { sanitizeErrorText } from '$lib/server/jobs/error-text';

/** Log detail without the recipient address an SMTP error may embed. */
const EMAIL_PATTERN = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;

function logDetail(error: unknown): string {
	return sanitizeErrorText(error).replace(EMAIL_PATTERN, '<address>');
}

/**
 * Password reset request. better-auth owns the token (verification row
 * `reset-password:<token>`, one hour) and the mail body; this action only calls
 * `requestPasswordReset`, which resolves the address and runs `sendResetPassword`
 * (`auth.ts`). Known and unknown addresses get the same answer; the sent-mail round
 * trip can still make a known address slower, which the per-address limit covers.
 */
export const load: PageServerLoad = () => {
	return { mailConfigured: isMailDeliveryAvailable() };
};

export const actions: Actions = {
	sendReset: async (event) => {
		// Fail-closed per-IP bucket (IPv6 aggregated on /64).
		const address = clientAddressKey(requestAddress(event.getClientAddress));
		const rate = await rateLimitStrict(getCache(), `limits:password-reset:${address}`, 5, 60 * 60);
		if (!rate.allowed) {
			event.setHeaders({ 'retry-after': '3600' });
			return fail(rate.unavailable ? 503 : 429, {
				message: rate.unavailable ? m.auth_err_unavailable() : m.auth_forgot_err_rate()
			});
		}

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
			// Anti-enumeration: the transport or the lookup may fail, but the answer
			// stays "check your inbox". better-auth logs transport failures itself, so
			// this mostly sees pre-send rejections; keep the cause, never the address.
			if (error instanceof APIError) {
				console.warn('[forgot-password] reset request rejected', logDetail(error.message));
			} else {
				console.error('[forgot-password] reset request failed', logDetail(error));
			}
		}

		return { success: true };
	}
};
