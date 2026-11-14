import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';
import { APIError } from 'better-auth/api';
import { auth } from '$lib/server/auth';
import { ADMIN_BASE_PATH, ADMIN_HOME_PATH, assertAdminSlug } from '$lib/server/config/admin';
import { getUserRole, hasAnyAdminCapability } from '$lib/server/authz';
import { isSiteOrganizationMember } from '$lib/server/auth/site-organization';
import { pruneOtherSessions } from '$lib/server/auth/sessions';
import { safeRedirect } from '$lib/server/safe-redirect';
import { getCache } from '$lib/server/cache';
import { rateLimitStrict } from '$lib/server/cache/store';
import { credentialBucketKey, requestAddress } from '$lib/server/security/request-address';
import { clientAddressKey } from '$lib/utils/cidr';

/** Admin credentials endpoint budget (W6.10): 10 attempts / 15 min / IP. */
const ADMIN_LOGIN_RATE_LIMIT = { limit: 10, windowSeconds: 15 * 60 } as const;

export const load: PageServerLoad = async (event) => {
	assertAdminSlug(event.params.adminSlug);

	const redirectTo = safeRedirect(event.url.searchParams.get('redirectTo'), ADMIN_HOME_PATH, {
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
		// W6.10 / review P1: admin credentials bucket keyed on the /64 address
		// AND a hash of the email, so an office NAT cannot lock out the owner.
		const address = clientAddressKey(requestAddress(event.getClientAddress));
		const rate = await rateLimitStrict(
			getCache(),
			credentialBucketKey('admin-login', address, email),
			ADMIN_LOGIN_RATE_LIMIT.limit,
			ADMIN_LOGIN_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) {
			event.setHeaders({ 'retry-after': String(ADMIN_LOGIN_RATE_LIMIT.windowSeconds) });
			return fail(rate.unavailable ? 503 : 429, {
				message: rate.unavailable ? m.auth_err_unavailable() : m.auth_login_err_rate()
			});
		}
		const password = formData.get('password')?.toString() ?? '';
		const redirectTo = safeRedirect(formData.get('redirectTo')?.toString(), ADMIN_HOME_PATH, {
			allowedPrefix: ADMIN_BASE_PATH
		});

		if (!email || !password) {
			return fail(400, { message: m.admin_auth_err_email_password_required(), redirectTo });
		}

		// Set on every path that exits the try: the catch below returns a form
		// error for both APIError and unexpected failures.
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
					return fail(403, { message: m.admin_auth_err_no_admin_access(), redirectTo });
				}

				if (!result.token) {
					return fail(500, { message: m.admin_auth_err_session_failed(), redirectTo });
				}

				await pruneOtherSessions(result.user.id, result.token);
			}
		} catch (caught) {
			if (caught instanceof APIError) {
				return fail(400, {
					message: caught.message || 'Invalid email or password',
					redirectTo
				});
			}

			return fail(500, { message: m.admin_auth_err_unexpected(), redirectTo });
		}

		if (twoFactorRequired) {
			redirect(302, `${config.twoFactorPath}?redirectTo=${encodeURIComponent(redirectTo)}`);
		}

		redirect(302, `${config.loginPath}?redirectTo=${encodeURIComponent(redirectTo)}`);
	}
};
