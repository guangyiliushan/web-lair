import { sequence } from '@sveltejs/kit/hooks';
import { building } from '$app/environment';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import type { Handle } from '@sveltejs/kit';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { db } from '$lib/server/db';
import { userProfiles } from '$lib/server/db/account/user-profile.schema';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { getAdminSessionContext, issueAdminSessionCookie } from '$lib/server/security/admin-cookie';
import { tryTailscaleAutoLogin } from '$lib/server/security/tailscale-auth';

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

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.admin = null;

	if (session) {
		const profile = await db.query.userProfiles.findFirst({
			where: eq(userProfiles.userId, session.user.id)
		});

		if (profile?.status === 'suspended') {
			return new Response('Account suspended', { status: 403 });
		}

		event.locals.session = session.session;
		event.locals.user = session.user;
		event.locals.admin = getAdminSessionContext(
			event.cookies,
			session.user,
			session.session,
			env.BETTER_AUTH_SECRET
		);
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

	// Tailscale 自动登录：在 /admin 路径下无 Better Auth session 时尝试
	if (!session && event.url.pathname.startsWith('/admin')) {
		const autoLogin = await tryTailscaleAutoLogin();
		if (autoLogin) {
			event.locals.user = autoLogin.user;
			event.locals.session = autoLogin.session;

			issueAdminSessionCookie(
				event.cookies,
				autoLogin.user,
				autoLogin.session,
				env.BETTER_AUTH_SECRET
			);
			event.locals.admin = getAdminSessionContext(
				event.cookies,
				autoLogin.user,
				autoLogin.session,
				env.BETTER_AUTH_SECRET
			);

			const profile = await db.query.userProfiles.findFirst({
				where: eq(userProfiles.userId, autoLogin.user.id)
			});
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
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = sequence(handleParaglide, handleBetterAuth);
