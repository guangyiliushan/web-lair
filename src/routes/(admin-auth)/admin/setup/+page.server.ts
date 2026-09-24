import { fail, redirect } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import { eq } from 'drizzle-orm';
import { getAdminConfig } from '$lib/server/config/admin';
import { claimOwnerRole, hasAnyAdminAccount } from '$lib/server/auth/owner';
import { ensureSiteOrganization } from '$lib/server/auth/site-organization-bootstrap';
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

		// Create user via Better Auth API (APIError -> form error, no 500 page)
		let result;
		try {
			result = await auth.api.signUpEmail({
				body: { email, password, name }
			});
		} catch (caught) {
			if (caught instanceof APIError) {
				return fail(400, { message: caught.message || 'Could not create the account.' });
			}
			throw caught;
		}

		// Bootstrap: the first account becomes the site owner. The claim takes an
		// advisory lock (two concurrent setups cannot both win) plus a conditional
		// UPDATE (idempotent for our own row) - see auth/owner-claim.ts.
		const claimed = await claimOwnerRole(result.user.id);
		if (!claimed) {
			// Raced with another bootstrap: drop the account we just created so it
			// cannot linger as an orphan (no owner, no way in). Cascades to its profile.
			await db.delete(user).where(eq(user.id, result.user.id));
			return fail(403, { message: 'Admin already exists.' });
		}

		// signUpEmail returns { token: null } while requireEmailVerification is on.
		// The session cookie itself comes from the sveltekitCookies plugin.
		// B2 (ledger §4.22): create the site organization and make the owner its
		// owner-member. Idempotent; failure is reported instead of continuing -
		// without it every org-scoped permission check would deny the owner.
		try {
			await ensureSiteOrganization(result.user.id);
		} catch (caught) {
			console.error('[setup] site organization bootstrap failed:', caught);
			return fail(500, {
				message:
					'Owner created, but the site organization could not be initialized. Check the server logs, then repair with `pnpm db:ensure-org`.'
			});
		}

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
