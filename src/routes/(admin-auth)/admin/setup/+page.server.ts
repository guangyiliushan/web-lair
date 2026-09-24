import { fail, redirect } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { getAdminConfig } from '$lib/server/config/admin';
import { claimOwnerRole, hasAnyAdminAccount } from '$lib/server/auth/owner';
import { APIError } from 'better-auth/api';

function verifySetupToken(formToken: string): string | null {
	const config = getAdminConfig();

	if (!config.setupToken) {
		return 'ADMIN_SETUP_TOKEN is not configured on the server.';
	}
	if (!formToken) {
		return 'Setup token is required.';
	}

	const a = Buffer.from(config.setupToken);
	const b = Buffer.from(formToken);
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return 'Invalid setup token.';
	}

	return null;
}

export const load: PageServerLoad = async () => {
	if (await hasAnyAdminAccount()) {
		redirect(303, '/admin');
	}

	const config = getAdminConfig();

	return {
		setupTokenConfigured: config.setupToken.length > 0
	};
};

export const actions: Actions = {
	setup: async (event) => {
		if (await hasAnyAdminAccount()) {
			return fail(403, { message: 'Admin already exists.' });
		}

		const formData = await event.request.formData();
		const email = formData.get('email')?.toString().trim().toLowerCase() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const name = formData.get('name')?.toString() ?? 'Admin';
		const formSetupToken = formData.get('setupToken')?.toString() ?? '';

		if (!email || !password) {
			return fail(400, { message: 'Email and password are required.' });
		}

		// Verify setup token
		const tokenError = verifySetupToken(formSetupToken);
		if (tokenError) {
			return fail(403, { message: tokenError });
		}

		// Create user via Better Auth API
		const result = await auth.api.signUpEmail({
			body: { email, password, name }
		});

		// Bootstrap: the first account becomes the site owner. The claim is a
		// conditional UPDATE, so a concurrent setup cannot mint a second owner.
		const claimed = await claimOwnerRole(result.user.id);
		if (!claimed) {
			return fail(403, { message: 'Admin already exists.' });
		}

		// signUpEmail returns { token: null } while requireEmailVerification is on.
		// The session cookie itself comes from the sveltekitCookies plugin.
		try {
			await auth.api.signInEmail({
				body: {
					email,
					password,
					callbackURL: '/admin'
				}
			});
		} catch (caught) {
			if (caught instanceof APIError) {
				return fail(500, {
					message: 'Account created but auto-login failed. Please sign in manually.'
				});
			}
			throw caught;
		}

		redirect(303, '/admin');
	}
};
