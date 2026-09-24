import { fail, redirect, error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { APIError } from 'better-auth/api';
import { auth } from '$lib/server/auth';
import { ADMIN_BASE_PATH, getAdminConfig } from '$lib/server/config/admin';
import { getUserRole } from '$lib/server/authz';
import { isSiteOrganizationMember } from '$lib/server/auth/site-organization';
import {
	findSessionIdByToken,
	pruneOtherSessions,
	revokeSessionById
} from '$lib/server/auth/sessions';
import { safeRedirect } from '$lib/server/safe-redirect';

function assertAdminSlug(slug: string) {
	const config = getAdminConfig();

	if (slug !== config.loginSlug) {
		error(404, 'Not found');
	}

	return config;
}

type VerifiedUser = { id?: string; role?: unknown; emailVerified?: boolean };
type VerifyResult = { token?: string | null; user?: VerifiedUser };

export const load: PageServerLoad = async (event) => {
	assertAdminSlug(event.params.adminSlug);

	const redirectTo = safeRedirect(event.url.searchParams.get('redirectTo'), ADMIN_BASE_PATH, {
		allowedPrefix: ADMIN_BASE_PATH
	});

	// Already signed in (e.g. the Tailnet bypass, or a second tab): nothing to do.
	if (event.locals.session) {
		redirect(302, redirectTo);
	}

	return {
		redirectTo
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
			return fail(400, { message: 'Enter your verification code.', redirectTo, useBackupCode });
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
				const status = (caught as { status?: number | string }).status;
				const rateLimited = status === 429 || status === 'TOO_MANY_REQUESTS';
				return fail(rateLimited ? 429 : 400, {
					message: caught.message || 'Invalid verification code',
					redirectTo,
					useBackupCode
				});
			}
			console.warn(
				'[two-factor] verification failed:',
				caught instanceof Error ? caught.message : caught
			);
			return fail(500, { message: 'Verification failed. Try again.', redirectTo, useBackupCode });
		}

		const user = result?.user;
		const userId = user?.id ?? '';
		const sessionId = await findSessionIdByToken(result?.token);
		const admitted =
			Boolean(userId) &&
			(getUserRole({ id: userId, role: user?.role }) !== null ||
				(await isSiteOrganizationMember(userId)));

		if (!admitted || !user?.emailVerified) {
			// Verified, but this account may not enter /admin (same admission rule as
			// the password sign-in): drop the session we just created.
			if (sessionId) await revokeSessionById(sessionId);
			return fail(403, { message: 'This account cannot access admin', redirectTo, useBackupCode });
		}

		if (sessionId) {
			await pruneOtherSessions(user.id as string, sessionId);
		}

		redirect(302, redirectTo);
	}
};
