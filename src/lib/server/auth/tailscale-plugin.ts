import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin, User } from 'better-auth';
import { getRequestEvent } from '$app/server';
import { getAdminConfig, safeAdminRedirectTarget } from '$lib/server/config/admin';
import { findSiteOwner, hasAnyAdminAccount } from '$lib/server/auth/owner';
import { resolveTailscaleIdentity } from '$lib/server/security/tailscale-auth';

/**
 * Tailnet sign-in that produces a *real* better-auth session.
 *
 * The previous flow inserted a `session` row by hand on every request and never
 * issued a cookie (ledger §4.27 洞②). This endpoint uses the official API
 * surface instead — `internalAdapter.createSession` + `setSessionCookie`, the
 * exact pair the bundled `anonymous` plugin uses, and the redirect idiom from
 * the callback routes (`throw ctx.redirect(url)`).
 */
export function tailscaleSignIn(): BetterAuthPlugin {
	return {
		id: 'tailscale-sign-in',
		endpoints: {
			tailscaleSignIn: createAuthEndpoint('/tailscale-sign-in', { method: 'GET' }, async (ctx) => {
				const config = getAdminConfig();
				const requestUrl = new URL(ctx.request?.url ?? 'http://localhost');
				const returnTo = safeAdminRedirectTarget(requestUrl.searchParams.get('returnTo'));
				const loginRedirect = `${config.loginPath}?redirectTo=${encodeURIComponent(returnTo)}`;

				const clientAddress = readClientAddress();
				const identity = resolveTailscaleIdentity(clientAddress, ctx.headers ?? new Headers());
				if (!identity) {
					throw ctx.redirect(loginRedirect);
				}

				const owner = await findSiteOwner();
				if (!owner) {
					throw ctx.redirect((await hasAnyAdminAccount()) ? loginRedirect : '/admin/setup');
				}
				if (!owner.emailVerified) {
					throw ctx.redirect(loginRedirect);
				}

				const session = await ctx.context.internalAdapter.createSession(owner.id);
				await setSessionCookie(ctx, { session, user: owner as unknown as User });
				throw ctx.redirect(returnTo);
			})
		}
	};
}

function readClientAddress(): string {
	try {
		return getRequestEvent().getClientAddress() ?? '';
	} catch {
		return '';
	}
}
