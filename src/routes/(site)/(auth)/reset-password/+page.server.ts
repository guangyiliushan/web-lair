import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';

export const load: PageServerLoad = (event) => {
	// The token is in this URL; strict-origin keeps the path out of Referer.
	event.setHeaders({ 'referrer-policy': 'strict-origin' });
	const token = event.url.searchParams.get('token');
	if (!token) {
		redirect(302, '/forgot-password');
	}
	return { token };
};

export const actions: Actions = {
	reset: async (event) => {
		const formData = await event.request.formData();
		const token = formData.get('token')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const confirmPassword = formData.get('confirmPassword')?.toString() ?? '';

		if (!token) {
			return fail(400, { message: 'Reset token is missing' });
		}

		if (!password || !confirmPassword) {
			return fail(400, { message: 'All fields are required' });
		}

		if (password !== confirmPassword) {
			return fail(400, { message: 'Passwords do not match' });
		}

		if (password.length < 8) {
			return fail(400, { message: 'Password must be at least 8 characters' });
		}

		try {
			await auth.api.resetPassword({
				body: {
					newPassword: password,
					token
				}
			});
		} catch (error) {
			if (error instanceof APIError) {
				return fail(400, { message: error.message || 'Password reset failed' });
			}
			return fail(500, { message: 'An unexpected error occurred' });
		}

		redirect(302, '/login?message=password-reset-success');
	}
};
