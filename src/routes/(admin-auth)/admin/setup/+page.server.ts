import { fail, redirect } from '@sveltejs/kit';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import { activities } from '$lib/server/db/system';
import { eq } from 'drizzle-orm';
import { recordActivity } from '$lib/server/audit';
import { ADMIN_HOME_PATH, getAdminConfig } from '$lib/server/config/admin';
import { claimOwnerRole, hasAnyAdminAccount } from '$lib/server/auth/owner';
import { ensureSiteOrganization } from '$lib/server/auth/site-organization-bootstrap';
import { APIError } from 'better-auth/api';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { requestAddress } from '$lib/server/security/request-address';

/**
 * One-time bootstrap marker (W2.12 / decision T5-A). The `setup token must be
 * invalidated after first use` rule cannot be satisfied by an
 * `if (an admin exists) reject` guard alone: emptying the user table would make
 * the token valid again. A durable audit row survives that and is the receipt
 * of which token was consumed.
 */
async function setupAlreadyConsumed(): Promise<boolean> {
	const [row] = await db
		.select({ id: activities.id })
		.from(activities)
		.where(eq(activities.event, 'admin.setup_complete'))
		.limit(1);
	return row !== undefined;
}

function setupTokenFingerprint(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8);
}

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
		redirect(303, ADMIN_HOME_PATH);
	}

	const config = getAdminConfig();

	return {
		setupTokenConfigured: config.setupToken.length > 0,
		// The token is one-time (W2.12): a completed bootstrap keeps the form
		// closed even if the user table was emptied afterwards.
		setupConsumed: await setupAlreadyConsumed()
	};
};

export const actions: Actions = {
	setup: async (event) => {
		if (await hasAnyAdminAccount()) {
			return fail(403, { message: m.admin_setup_err_admin_exists() });
		}
		if (await setupAlreadyConsumed()) {
			return fail(403, {
				message:
					'Setup has already been completed with this token. Remove ADMIN_SETUP_TOKEN from the environment and sign in with the existing owner account.'
			});
		}

		const address = requestAddress(event.getClientAddress);
		const rate = await rateLimit(getCache(), `limits:setup:${address}`, 5, 15 * 60);
		if (!rate.allowed) return fail(429, { message: 'Too many attempts. Try again later.' });

		const formData = await event.request.formData();
		const email = formData.get('email')?.toString().trim().toLowerCase() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const name = formData.get('name')?.toString() ?? 'Admin';
		const formSetupToken = formData.get('setupToken')?.toString() ?? '';

		if (!email || !password) {
			return fail(400, { message: m.admin_auth_err_email_password_required() });
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
			return fail(403, { message: m.admin_setup_err_admin_exists() });
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

		// Durable one-time marker: written before the session exists, so a
		// crash cannot leave an unconsumed token behind. It carries the token
		// fingerprint (first 8 hex chars), never the token itself.
		try {
			await recordActivity(db, {
				event: 'admin.setup_complete',
				actorId: result.user.id,
				payload: {
					userId: result.user.id,
					tokenFingerprint: setupTokenFingerprint(formSetupToken),
					ownerEmail: email
				},
				// Bootstrap metadata stays local (decision A2).
				deliver: false
			});
		} catch (caught) {
			console.error('[setup] one-time marker failed:', caught);
			return fail(500, {
				message:
					'Owner created, but the one-time setup marker could not be written. Remove ADMIN_SETUP_TOKEN from the environment, then sign in with the password you just set.'
			});
		}

		try {
			await auth.api.signInEmail({
				body: {
					email,
					password,
					callbackURL: ADMIN_HOME_PATH
				}
			});
		} catch (caught) {
			if (caught instanceof APIError) {
				return fail(500, {
					message: m.admin_setup_err_autologin_failed()
				});
			}
			throw caught;
		}

		redirect(303, ADMIN_HOME_PATH);
	}
};
