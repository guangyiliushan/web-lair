import { fail } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { isMailDeliveryAvailableLive, sendVerificationFailure } from '$lib/server/mail/transport';
import { requestAddress } from '$lib/server/security/request-address';
import { m } from '$lib/paraglide/messages';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	return {};
};

export const actions: Actions = {
	resend: async (event) => {
		const form = await event.request.formData();
		const email = String(form.get('email') ?? '')
			.trim()
			.toLowerCase();
		if (!email) return fail(400, { message: m.auth_email() });

		const address = requestAddress(event.getClientAddress);
		const rate = await rateLimit(getCache(), `limits:verify:${address}`, 5, 60 * 60);
		if (!rate.allowed) return fail(429, { message: m.auth_register_err_rate() });
		if (!(await isMailDeliveryAvailableLive())) {
			return fail(503, { message: m.auth_register_mail_unconfigured() });
		}

		try {
			await auth.api.sendVerificationEmail({
				body: { email, callbackURL: '/auth/verification-success' }
			});
		} catch (error) {
			// Do not reveal whether the address exists; log the transport failure.
			sendVerificationFailure(email, error);
		}
		return { sent: true };
	}
};
