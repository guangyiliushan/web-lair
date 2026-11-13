import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { safeRedirect } from '$lib/server/safe-redirect';
import { APIError } from 'better-auth/api';

export const load: PageServerLoad = (event) => {
	if (event.locals.user) {
		redirect(302, '/admin');
	}
	// PRG landing spot after a completed reset: the reset action redirects here
	// with `?message=password-reset-success` (W1.4).
	return { resetSuccess: event.url.searchParams.get('message') === 'password-reset-success' };
};

export const actions: Actions = {
	signIn: async (event) => {
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
				callbackURL
			}
		});

		if (result.url) {
			redirect(302, result.url);
		}
		return fail(400, { message: 'Social sign-in failed' });
	}
};
