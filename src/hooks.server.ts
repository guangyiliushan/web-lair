import { sequence } from '@sveltejs/kit/hooks';
import { building, dev } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { db } from '$lib/server/db';
import { userProfiles } from '$lib/server/db/account/user-profile.schema';
import { eq } from 'drizzle-orm';
import { adminContextFor } from '$lib/server/authz';
import { ADMIN_BASE_PATH, getAdminConfig, isAdminPath } from '$lib/server/config/admin';
import { shouldAttemptTailscaleSignIn } from '$lib/server/security/tailscale-auth';
import { isSignUpRequest } from '$lib/server/auth-gate';
import { isMailDeliveryAvailableLive } from '$lib/server/mail/transport';
import { isCsrfForbidden } from '$lib/server/security/csrf';
import { isSubscriptionToken } from '$lib/server/services/subscription-token';
import { assertSuppressionKey } from '$lib/server/services/suppressions';
import { assertSubscriptionTokenSecret } from '$lib/server/services/subscriptions';

/**
 * Fail fast on boot when a required key is missing: without one, opt-out hashes
 * cannot be re-derived (`SUPPRESSION_HMAC_KEY`) and confirmation links cannot be
 * minted (`SUBSCRIBE_TOKEN_SECRET`). `building` is exempt because SvelteKit may
 * run `init` during prerender; dev boots keyless, but subscribe/confirm/
 * unsubscribe (reads included) fail until both keys are set.
 */
export const init: ServerInit = () => {
	if (!dev && !building) {
		assertSuppressionKey();
		assertSubscriptionTokenSecret();
	}
};

/**
 * SvelteKit's CSRF check runs before any hook, so it cannot exempt the RFC 8058
 * one-click unsubscribe endpoint. `svelte.config.js` turns the framework check
 * off (`csrf.trustedOrigins: ['*']`) and this hook re-implements it for every
 * other form request; keep `$lib/server/security/csrf` aligned with upstream.
 * The exempted POST is token-authenticated and carries no ambient authority.
 */
const ONE_CLICK_PATH = '/api/unsubscribe/one-click';

const handleCsrf: Handle = async ({ event, resolve }) => {
	if (
		!dev &&
		isCsrfForbidden({ request: event.request, selfOrigin: event.url.origin }) &&
		!(
			event.request.method === 'POST' &&
			event.url.pathname === ONE_CLICK_PATH &&
			isSubscriptionToken(event.url.searchParams.get('token') ?? '')
		)
	) {
		const message = `Cross-site ${event.request.method} form submissions are forbidden`;
		return event.request.headers.get('accept') === 'application/json'
			? new Response(JSON.stringify({ message }), {
					status: 403,
					headers: { 'content-type': 'application/json' }
				})
			: new Response(message, { status: 403 });
	}
	return resolve(event);
};

const handleParaglide: Handle = async ({ event, resolve }) =>
	paraglideMiddleware(event.request, async ({ request, locale }) => {
		event.request = request;

		const response = await resolve(event, {
			transformPageChunk: ({ html }) =>
				html.replace('%lang%', locale).replace('%dir%', getTextDirection(locale))
		});

		// The page depends on the locale cookie and, on a first visit, on
		// Accept-Language, so shared caches must key on both. Rebuild the response
		// rather than mutate it: Headers can be immutable on some runtimes.
		if (!response.headers.get('content-type')?.includes('text/html')) return response;
		const headers = new Headers(response.headers);
		const tokens = (headers.get('vary') ?? '')
			.split(',')
			.map((token) => token.trim())
			.filter(Boolean);
		for (const required of ['Cookie', 'Accept-Language']) {
			if (!tokens.includes(required)) tokens.push(required);
		}
		headers.set('vary', tokens.join(', '));
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	});

function clientAddress(event: Parameters<Handle>[0]['event']): string {
	try {
		return event.getClientAddress() ?? '';
	} catch {
		return '';
	}
}

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	if (isSignUpRequest({ method: event.request.method, pathname: event.url.pathname })) {
		// Probe SMTP here: a swallowed send error would create an account that
		// can never be verified.
		if (!(await isMailDeliveryAvailableLive())) {
			return new Response(JSON.stringify({ code: 'mail_unavailable' }), {
				status: 503,
				headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
			});
		}
	}

	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.admin = null;

	if (session) {
		const profile = await db.query.userProfiles.findFirst({
			where: eq(userProfiles.userId, session.user.id)
		});

		// Block the app surface for soft-deleted accounts, but keep /api/* reachable
		// so the session can still be terminated (sign-out, password change, ...).
		if (profile?.status === 'deleted' && !event.url.pathname.startsWith('/api/')) {
			return new Response('Account deleted', { status: 403 });
		}

		event.locals.session = session.session;
		event.locals.user = session.user;
		// Roles come from the better-auth admin plugin; the workspace guard reads this.
		event.locals.admin = adminContextFor(session.user);
		if (profile) {
			event.locals.profile = {
				displayName: profile.displayName,
				slug: profile.slug,
				bio: profile.bio,
				avatarUrl: profile.avatarUrl,
				status: profile.status
			};
		}
	}

	// Tailnet sign-in: with no session, hand /admin to the official plugin endpoint,
	// which resolves the identity and issues a real session + cookie. No session row
	// is inserted here.
	if (!session && isAdminPath(event.url.pathname)) {
		const { loginPath, twoFactorPath } = getAdminConfig();
		const isLoginPage = event.url.pathname.startsWith(loginPath);
		const isSetupPage = event.url.pathname.startsWith(`${ADMIN_BASE_PATH}/setup`);
		// The 2FA page is where the second factor is enforced; auto-signing in via
		// the Tailnet hand-off would silently skip it on trusted devices.
		const isTwoFactorPage = event.url.pathname.startsWith(twoFactorPath);

		if (!isLoginPage && !isSetupPage && !isTwoFactorPage) {
			const shouldSignIn = shouldAttemptTailscaleSignIn(
				clientAddress(event),
				event.request.headers
			);
			if (shouldSignIn) {
				const returnTo = event.url.pathname + event.url.search;
				redirect(303, `/api/auth/tailscale-sign-in?returnTo=${encodeURIComponent(returnTo)}`);
			}
		}
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = sequence(handleCsrf, handleParaglide, handleBetterAuth);

/**
 * Kit's default error hook logs the raw error; a `DrizzleQueryError` embeds the
 * SQL and bound parameters, so draft titles and bodies would land in the server
 * log. Log status + route id + PG code only and answer with a generic message.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const code =
		(error as { cause?: { code?: string }; code?: string } | null)?.cause?.code ??
		(error as { code?: string } | null)?.code;
	console.warn(
		'[error]',
		status,
		event.url.pathname,
		event.route.id ?? '-',
		code ?? message ?? '-'
	);
	return { message: 'Internal server error' };
};
