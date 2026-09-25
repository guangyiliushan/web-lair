import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { APIError } from 'better-auth/api';
import { auth } from '$lib/server/auth';
import { ADMIN_BASE_PATH, assertAdminSlug } from '$lib/server/config/admin';
import { getUserRole } from '$lib/server/authz';
import { isSiteOrganizationMember } from '$lib/server/auth/site-organization';
import { pruneOtherSessions, revokeSessionByToken } from '$lib/server/auth/sessions';
import { safeRedirect } from '$lib/server/safe-redirect';

type VerifiedUser = { id?: string; role?: unknown; emailVerified?: boolean };
type VerifyResult = { token?: string | null; user?: VerifiedUser };

/** Failure codes the page maps to localized copy (see the +page.svelte map). */
type TwoFactorErrorCode = 'invalid_code' | 'expired' | 'locked' | 'generic';

/**
 * The plugin throws its failures as `APIError.from(status, "<message>")`, and
 * better-auth 1.7.5 keeps neither message nor body for that call shape (probed:
 * `message === ''`, `body === {}`). Classification therefore keys off the
 * status string alone; invalid-code vs expired-challenge BOTH surface as
 * UNAUTHORIZED, so the presence of the challenge cookie decides (B3.1 review).
 */
function classifyFailure(caught: APIError, hasChallengeCookie: boolean): TwoFactorErrorCode {
	const status = String((caught as { status?: unknown }).status ?? '');
	// assertTwoFactorNotLocked throws TOO_MANY_REQUESTS after too many failures.
	if (status === '429' || status === 'TOO_MANY_REQUESTS') return 'locked';
	if (status === '401' || status === 'UNAUTHORIZED') {
		return hasChallengeCookie ? 'invalid_code' : 'expired';
	}
	return 'generic';
}

/**
 * The challenge lives in `better-auth.two_factor`; the name prefix is
 * deployment-configurable, so match the suffix instead of the full name.
 */
function hasTwoFactorChallengeCookie(cookies: { getAll(): { name: string }[] }): boolean {
	return cookies.getAll().some((cookie) => cookie.name.endsWith('two_factor'));
}

export const load: PageServerLoad = async (event) => {
	const config = assertAdminSlug(event.params.adminSlug);

	const redirectTo = safeRedirect(event.url.searchParams.get('redirectTo'), ADMIN_BASE_PATH, {
		allowedPrefix: ADMIN_BASE_PATH
	});

	// Already signed in (e.g. the Tailnet bypass, or a second tab): nothing to do.
	if (event.locals.session) {
		redirect(302, redirectTo);
	}

	return {
		redirectTo,
		loginPath: config.loginPath
	};
};

export const actions: Actions = {
	verify: async (event) => {
		assertAdminSlug(event.params.adminSlug);

		const formData = await event.request.formData();
		const code = formData.get('code')?.toString().trim() ?? '';
		const useBackupCode = formData.get('method')?.toString() === 'backup';
		const redirectTo = safeRedirect(formData.get('redirectTo')?.toString(), ADMIN_BASE_PATH, {
			allowedPrefix: ADMIN_BASE_PATH
		});

		if (!code) {
			return fail(400, { message: 'Enter your verification code.' });
		}

		let result: VerifyResult | undefined;
		try {
			// The `two_factor` challenge cookie (10 min) rides along with the request;
			// a successful verification returns the freshly created session, exactly
			// like a normal sign-in (see better-auth 1.7.5 verify-two-factor).
			result = useBackupCode
				? await auth.api.verifyBackupCode({ body: { code }, headers: event.request.headers })
				: await auth.api.verifyTOTP({ body: { code }, headers: event.request.headers });
		} catch (caught) {
			if (caught instanceof APIError) {
				const errorCode = classifyFailure(caught, hasTwoFactorChallengeCookie(event.cookies));
				console.warn('[2fa] verification rejected', {
					errorCode,
					status: String((caught as { status?: unknown }).status ?? ''),
					method: useBackupCode ? 'backup' : 'totp'
				});
				return fail(errorCode === 'locked' ? 429 : 400, {
					message: caught.message || 'Invalid verification code',
					errorCode
				});
			}
			console.warn('[2fa] verification failed:', caught instanceof Error ? caught.message : caught);
			return fail(500, { message: 'Verification failed. Try again.' });
		}

		const user = result?.user;
		const userId = user?.id ?? '';
		const sessionToken = result?.token ?? null;

		let admitted = false;
		try {
			admitted =
				Boolean(userId) &&
				(getUserRole({ id: userId, role: user?.role }) !== null ||
					(await isSiteOrganizationMember(userId)));
		} catch (caught) {
			// A DB hiccup must not become an open door: treat it as not admitted.
			console.warn(
				'[2fa] admission check failed:',
				caught instanceof Error ? caught.message : caught
			);
		}

		if (!admitted || !user?.emailVerified) {
			// Verified, but this account may not enter /admin (same admission rule
			// as the password sign-in): drop the session we just created. A failed
			// revoke is logged and grants nothing by itself - every admin surface
			// re-checks admission with the real cookie.
			if (sessionToken) {
				try {
					await revokeSessionByToken(sessionToken);
				} catch (caught) {
					console.warn(
						'[2fa] could not revoke the new session:',
						caught instanceof Error ? caught.message : caught
					);
				}
			}
			return fail(403, { message: 'This account cannot access admin' });
		}

		if (sessionToken) {
			try {
				await pruneOtherSessions(userId, sessionToken);
			} catch (caught) {
				console.warn(
					'[2fa] single-session prune failed:',
					caught instanceof Error ? caught.message : caught
				);
			}
		} else {
			// The plugin always issues a session here; a missing token means the
			// response shape changed - log instead of failing open silently.
			console.warn('[2fa] verify succeeded without a session token; nothing to prune', {
				userId
			});
		}

		console.info('[2fa] verified', { userId, method: useBackupCode ? 'backup' : 'totp' });
		redirect(302, redirectTo);
	}
};
