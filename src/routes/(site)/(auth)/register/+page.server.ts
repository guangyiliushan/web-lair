import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';
import { isMailDeliveryAvailable } from '$lib/server/mail/transport';
import { m } from '$lib/paraglide/messages';

export const load: PageServerLoad = (event) => {
	if (event.locals.user) {
		redirect(302, '/admin');
	}
	return { mailConfigured: isMailDeliveryAvailable() };
};

export const actions: Actions = {
	signUp: async (event) => {
		if (!isMailDeliveryAvailable()) {
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
