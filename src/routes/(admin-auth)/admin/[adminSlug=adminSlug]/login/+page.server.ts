import { fail, redirect, error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { APIError } from 'better-auth/api';
import { auth } from '$lib/server/auth';
import { ADMIN_BASE_PATH, getAdminConfig } from '$lib/server/config/admin';
import { getUserRole, hasAnyAdminCapability } from '$lib/server/authz';
import { isSiteOrganizationMember } from '$lib/server/auth/site-organization';
import { findSessionIdByToken, pruneOtherSessions } from '$lib/server/auth/sessions';
import { safeRedirect } from '$lib/server/safe-redirect';

function assertAdminSlug(slug: string) {
	const config = getAdminConfig();

	if (slug !== config.loginSlug) {
		error(404, 'Not found');
	}

	return config;
}

export const load: PageServerLoad = async (event) => {
	assertAdminSlug(event.params.adminSlug);

	const redirectTo = safeRedirect(event.url.searchParams.get('redirectTo'), ADMIN_BASE_PATH, {
		allowedPrefix: ADMIN_BASE_PATH
	});

	// PRG landing spot: an authenticated admin-capable session skips the form.
	if (event.locals.session && (await hasAnyAdminCapability(event.locals.user))) {
		redirect(302, redirectTo);
	}

	return {
		redirectTo
	};
};

export const actions: Actions = {
	signIn: async (event) => {
		const config = assertAdminSlug(event.params.adminSlug);
		const formData = await event.request.formData();
		const email = formData.get('email')?.toString().trim().toLowerCase() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const redirectTo = safeRedirect(formData.get('redirectTo')?.toString(), ADMIN_BASE_PATH, {
			allowedPrefix: ADMIN_BASE_PATH
		});

		if (!email || !password) {
			return fail(400, { message: 'Email and password are required', redirectTo });
		}

		// Assigned on every path that reaches the check below: the catch either
		// returns a form error or rethrows (both non-APIError and APIError cases).
		let twoFactorRequired: boolean;

		try {
			const result = await auth.api.signInEmail({
				body: {
					email,
					password,
					callbackURL: '/auth/verification-success'
				}
			});

			// B3: a 2FA-enabled account gets no session here - the plugin deletes the
			// session it just created and answers with a challenge instead, so the
			// response carries no user/token. Admission is decided after verification
			// on the two-factor page; the challenge cookie (10 min) does the routing.
			twoFactorRequired = Boolean((result as { twoFactorRedirect?: boolean }).twoFactorRedirect);

			if (!twoFactorRequired) {
				// Roles replaced the email allowlist + the admin_account table (ledger
				// Q13/§4.10). Organization members (reviewers, B2) are admitted by
				// membership: the session this sign-in just created is not visible in
				// the request headers yet, so the capability itself is re-checked with
				// the real cookie by the /admin guard and the comment queue.
				const admitted =
					getUserRole(result.user) !== null || (await isSiteOrganizationMember(result.user.id));
				if (!admitted || !result.user.emailVerified) {
					return fail(403, { message: 'This account cannot access admin', redirectTo });
				}

				const sessionId = await findSessionIdByToken(result.token);
				if (!sessionId) {
					return fail(500, { message: 'Failed to establish admin session', redirectTo });
				}

				await pruneOtherSessions(result.user.id, sessionId);
			}
		} catch (caught) {
			if (caught instanceof APIError) {
				return fail(400, {
					message: caught.message || 'Invalid email or password',
					redirectTo
				});
			}

			return fail(500, { message: 'An unexpected error occurred', redirectTo });
		}

		if (twoFactorRequired) {
			redirect(302, `${config.twoFactorPath}?redirectTo=${encodeURIComponent(redirectTo)}`);
		}

		redirect(302, `${config.loginPath}?redirectTo=${encodeURIComponent(redirectTo)}`);
	}
};
