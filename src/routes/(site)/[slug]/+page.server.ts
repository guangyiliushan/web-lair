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
 * Universal md-page route. Rows serve their body strictly in the current locale: a
 * missing language is a 404 with a hint listing the locales that do carry content,
 * never a silent fallback (same contract as posts and notes). External rows and
 * rows without a body are plain 404s; `hidden` rows stay directly reachable —
 * hiding is a menu-level concern, not access control.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const lang = getLocale();

	// Locale tags are never page slugs: a row claiming `en` would turn `/en` into a
	// 200 with collapsed localised links. The editor and `db:verify-pages` reject
	// such slugs via the shared reserved list; this is the read-side belt for rows
	// that predate that entry.
	if ((locales as readonly string[]).includes(params.slug)) {
		error(404, 'Not found');
	}

	const row = await getPageBySlug(params.slug);

	// The structural half of the servable-page predicate is shared with the comment
	// write path; the missing-language hint below stays route-owned.
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

	// hreflang set: content locales only, same path per locale, self included
	// (`x-default` is not emitted).
	const alternates = contentLangs.map((tag) => ({
		lang: tag,
		path: `/${row.slug}`
	}));

	// Viewer state for the comment section (mirrors the posts/notes mounts). Pages
	// have no per-row switch, so threads always load; the site-wide switch still
	// blocks new comments while existing approved rows keep rendering.
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
			privacyNotice: true,
			commentsClosed: !commentsEnabled,
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

	return commentSubmitResponse(result, event);
}

export const actions = {
	comment: (event) => handleSubmit(event, false),
	reply: (event) => handleSubmit(event, true),
	edit: commentEditAction,
	delete: commentDeleteAction
} satisfies Actions;
