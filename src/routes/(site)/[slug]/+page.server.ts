import { error, fail } from '@sveltejs/kit';
import { getLocale, localizeHref, locales } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { requireUser } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { requestIp } from '$lib/server/security/request-address';
import { geoFromHeaders } from '$lib/server/security/geoip';
import {
	loadThreads,
	resolveCommentPageTarget,
	submitComment
} from '$lib/server/services/comments';
import {
	commentDeleteAction,
	commentEditAction,
	commentSubmitResponse
} from '$lib/server/services/comments-actions';
import {
	contentLocales,
	getPageBySlug,
	isServablePageRow,
	resolveLocalized,
	servablePageBody
} from '$lib/server/services/pages';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * Universal md-page route (pages line P1b; 2026-10-03 rulings). Any-status
 * rows serve their body STRICTLY in the current locale: a missing language is
 * a 404 with a hint listing the locales that do carry content - never a
 * silent fallback (mirror of the posts/notes language contract). External
 * rows and rows without body content are plain 404s here; code rows live on
 * their own file routes, which rank above this dynamic segment. `hidden` rows
 * stay directly reachable - hiding is a menu-level concern.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const lang = getLocale();

	// Locale tags are never page slugs: the bare-language roots stay 404s by
	// design (P3-a identity patterns), and a row claiming e.g. `en` would turn
	// `/en` into a 200 with collapsed localised links. The admin editor and
	// `db:verify-pages` reject such slugs through the shared reserved list;
	// this is the read-side belt for rows that predate that entry.
	if ((locales as readonly string[]).includes(params.slug)) {
		error(404, 'Not found');
	}

	const row = await getPageBySlug(params.slug);

	// The structural half of the servable-page predicate is shared with the
	// comment write path (pre-release review 01-P2-2); the missing-language
	// hint below stays route-owned.
	if (!row || !isServablePageRow(row)) {
		error(404, 'Not found');
	}

	const contentLangs = contentLocales(row.content);
	const body = servablePageBody(row, lang);

	if (body === null) {
		// The hint keeps its meaning only while some locale carries content; an
		// empty content object falls through to a plain 404 (nothing to offer).
		if (contentLangs.length === 0) {
			error(404, 'Not found');
		}
		error(404, {
			message: m.error_page_language_hint(),
			available: contentLangs.map((tag) => ({
				lang: tag,
				href: localizeHref(`/${row.slug}`, { locale: tag as (typeof locales)[number] })
			}))
		});
	}

	const html = await renderMarkdownToHtml(body);
	const title = resolveLocalized(row.title, lang) ?? row.slug;
	const description = resolveLocalized(row.description, lang);

	// hreflang set: the locales that carry content, same path per locale, self
	// included (x-default stays deferred; ruling 2026-10-03).
	const alternates = contentLangs.map((tag) => ({
		lang: tag,
		path: `/${row.slug}`
	}));

	// Viewer state for the comment section (mirrors the posts/notes mounts;
	// pages carry no per-row switch - plan §0 #46, so the threads always load).
	// The site-wide switch still blocks new comments (W6.1 / C1) while existing
	// approved rows keep rendering.
	const user = locals.user;
	const emailVerified = Boolean(user?.emailVerified);
	const commentsEnabled = await getOption('comments.enabled');
	const privacy = await getOption('comments.privacy');
	const showCountry = privacy.enabled && privacy.collectCountry && privacy.showCountry;
	const canComment = Boolean(user) && emailVerified && commentsEnabled;
	const loginUrl = user
		? null
		: `/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`;
	const threads = await loadThreads({
		targetType: 'page',
		targetId: row.id,
		viewerId: user?.id ?? null,
		showCountry
	});

	return {
		seo: { path: `/${row.slug}`, alternates },
		page: { slug: row.slug, title, description },
		html,
		viewer: {
			emailVerified,
			canComment,
			loginUrl,
			privacyNotice: privacy.enabled,
			countryOptIn: showCountry
		},
		discussion: commentsEnabled || threads.visibleCount > 0 ? threads : null
	};
};

/**
 * Shared submit path for the comment/reply actions (mirrors the posts
 * detail page): the target is resolved from the URL slug server-side, and
 * the service re-validates it authoritatively.
 */
async function handleSubmit(event: RequestEvent, isReply: boolean) {
	const user = requireUser();
	if (!user.emailVerified) {
		return fail(403, { message: m.comment_verify_hint() });
	}

	const form = await event.request.formData();
	const text = form.get('text')?.toString() ?? '';
	const parentId = isReply ? (form.get('parentId')?.toString() ?? null) : null;

	// One timestamp for the whole submission: target resolution and the
	// service re-check must agree on the visibility boundary.
	const now = new Date();
	const lang = getLocale();
	const targetId = await resolveCommentPageTarget(lang, event.params.slug);
	if (!targetId) return fail(404, { message: m.comment_error_unavailable() });

	const profile = event.locals.profile;
	const result = await submitComment({
		targetType: 'page',
		targetId,
		lang,
		parentId,
		text,
		user,
		author: profile?.displayName ?? user.name ?? 'Reader',
		avatar: profile?.avatarUrl ?? user.image ?? null,
		ip: requestIp(event.getClientAddress),
		geo: geoFromHeaders(event.request.headers),
		showCountry: form.get('showCountry') !== null,
		now
	});

	return commentSubmitResponse(result);
}

export const actions = {
	comment: (event) => handleSubmit(event, false),
	reply: (event) => handleSubmit(event, true),
	edit: commentEditAction,
	delete: commentDeleteAction
} satisfies Actions;
