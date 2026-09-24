import { sequence } from '@sveltejs/kit/hooks';
import { building } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import type { Handle } from '@sveltejs/kit';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { db } from '$lib/server/db';
import { userProfiles } from '$lib/server/db/account/user-profile.schema';
import { eq } from 'drizzle-orm';
import { adminContextFor } from '$lib/server/authz';
import { ADMIN_BASE_PATH, getAdminConfig, isAdminPath } from '$lib/server/config/admin';
import { shouldAttemptTailscaleSignIn } from '$lib/server/security/tailscale-auth';

const handleParaglide: Handle = async ({ event, resolve }) =>
	paraglideMiddleware(event.request, async ({ request, locale }) => {
		event.request = request;

		const response = await resolve(event, {
			transformPageChunk: ({ html }) =>
				html.replace('%lang%', locale).replace('%dir%', getTextDirection(locale))
		});

		// The rendered page depends on the locale cookie and - on a first visit
		// with no cookie yet - on Accept-Language, so a shared cache has to key
		// on both (MDN: Vary). Rebuild the response instead of mutating it:
		// Headers can be immutable on some runtimes.
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

	// Tailnet sign-in: with no session, hand /admin off to the official plugin
	// endpoint, which resolves the identity and issues a real session + cookie.
	// No session row is ever inserted here (ledger §4.27 洞②).
	if (!session && isAdminPath(event.url.pathname)) {
		const { loginPath } = getAdminConfig();
		const isLoginPage = event.url.pathname.startsWith(loginPath);
		const isSetupPage = event.url.pathname.startsWith(`${ADMIN_BASE_PATH}/setup`);

		if (!isLoginPage && !isSetupPage) {
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

export const handle: Handle = sequence(handleParaglide, handleBetterAuth);
