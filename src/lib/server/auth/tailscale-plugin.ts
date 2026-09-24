import { createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin, User } from 'better-auth';
import { getRequestEvent } from '$app/server';
import { env } from '$env/dynamic/private';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { userProfiles } from '$lib/server/db/account/user-profile.schema';
import { getAdminConfig, safeAdminRedirectTarget } from '$lib/server/config/admin';
import { findSiteOwner, hasAnyAdminAccount } from '$lib/server/auth/owner';
import { isTrustedNavigation } from '$lib/server/security/identity';
import { resolveTailscaleIdentity } from '$lib/server/security/tailscale-auth';

/**
 * Tailnet sign-in that produces a *real* better-auth session.
 *
 * The previous flow inserted a `session` row by hand on every request and never
 * issued a cookie (ledger §4.27 洞②). This endpoint uses the official API
 * surface instead — `internalAdapter.createSession` + `setSessionCookie`, the
 * exact pair the bundled `anonymous` plugin uses, and the redirect idiom from
 * the callback routes (`throw ctx.redirect(url)`).
 *
 * Three guards a custom endpoint must carry itself (the framework's own sign-in
 * routes get them from middleware / `session.create.before` hooks, neither of
 * which runs here):
 *  1. idempotency — an existing session is sent straight back instead of minting
 *     a fresh 30-day session (this GET is reachable by prefetch, retry, replay);
 *  2. navigation origin — `originCheckMiddleware` skips GET entirely, so the
 *     request has to prove it is same-origin itself (Fetch Metadata, fail closed);
 *  3. account state — banned / soft-deleted accounts are refused.
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
				const headers = ctx.headers ?? new Headers();

				// 1) Idempotency: already signed in -> straight back to the target.
				if (await getSessionFromCtx(ctx)) {
					throw ctx.redirect(returnTo);
				}

				// 2) This GET changes state, so it has to vouch for its own origin.
				// `options.baseURL` may be a dynamic config, so only a plain string counts.
				const configuredBaseURL = ctx.context.options.baseURL;
				const expectedOrigin =
					(typeof configuredBaseURL === 'string' ? configuredBaseURL : null) ?? env.ORIGIN ?? null;
				if (!isTrustedNavigation(headers, expectedOrigin)) {
					console.warn('[tailscale-sign-in] refused: untrusted navigation origin');
					throw ctx.redirect(loginRedirect);
				}

				const identity = resolveTailscaleIdentity(readClientAddress(), headers);
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

				// 3) Mirror the official `session.create.before` checks.
				if (owner.banned && (!owner.banExpires || owner.banExpires.getTime() > Date.now())) {
					console.warn('[tailscale-sign-in] refused: account is banned');
					throw ctx.redirect(loginRedirect);
				}
				const profile = await db.query.userProfiles.findFirst({
					where: eq(userProfiles.userId, owner.id)
				});
				if (profile?.status === 'deleted') {
					console.warn('[tailscale-sign-in] refused: account is deleted');
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
