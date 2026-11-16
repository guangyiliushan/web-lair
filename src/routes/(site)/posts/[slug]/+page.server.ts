import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getLocale, localizeHref, locales } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { db } from '$lib/server/db';
import { categories, postTags, posts, tags } from '$lib/server/db/content';
import { requireUser } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { requestIp } from '$lib/server/security/request-address';
import { geoFromHeaders } from '$lib/server/security/geoip';
import { resolveCommentPostTarget, submitComment } from '$lib/server/services/comments';
import {
	commentDeleteAction,
	commentEditAction,
	commentSubmitResponse,
	readCommentAnchorDraft
} from '$lib/server/services/comments-actions';
import { renderDiscussion } from '$lib/server/services/comment-render';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { resolveTaxonomyName } from '$lib/server/services/taxonomy';
import { findSlugTargetId } from '$lib/server/services/slug-resolver';
import { formatDate } from '$lib/utils/i18n';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * Public post detail: the post must exist in the URL's locale and pass the shared
 * visibility condition. A missing language version is a 404 with a hint listing
 * the languages that have the same slug, never an automatic fallback. A retired
 * slug resolves through `slug_trackers` with a single 301 hop.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const lang = getLocale();
	const { slug } = params;
	// One timestamp for both visibility checks, so a boundary post cannot be
	// hidden for this language yet listed as available in the hint query.
	const now = new Date();

	const [row] = await db
		.select({
			id: posts.id,
			slug: posts.slug,
			lang: posts.lang,
			title: posts.title,
			summary: posts.summary,
			summaryAi: sql<boolean>`exists (
				select 1 from summaries s
				where s.post_id = ${posts.id} and s.lang = ${posts.lang}
					and s.adopted_at is not null and s.summary = ${posts.summary}
			)`,
			content: posts.content,
			publishedAt: posts.publishedAt,
			updatedAt: posts.updatedAt,
			readCount: posts.readCount,
			likeCount: posts.likeCount,
			categoryName: categories.name,
			categorySourceLang: categories.sourceLang,
			categoryNameI18n: categories.nameI18n,
			allowComment: posts.allowComment,
			translationGroup: posts.translationGroup,
			translationOrigin: posts.translationOrigin,
			writingOrigin: posts.writingOrigin,
			aiHelp: posts.aiHelp,
			translatedFromPostId: posts.translatedFromPostId
		})
		.from(posts)
		.innerJoin(categories, eq(posts.categoryId, categories.id))
		.where(and(eq(posts.lang, lang), eq(posts.slug, slug), visiblePostCondition(now)))
		.limit(1);

	if (!row) {
		// Slug fallback chain: a retired slug resolves through `slug_trackers`
		// (single hop — trackers point at the row id, so chains cannot form). An
		// invisible, missing or self-referencing target is a plain 404: never
		// redirect into hidden content or a loop.
		const trackedId = await findSlugTargetId('post', lang, slug);
		if (trackedId) {
			const [target] = await db
				.select({ slug: posts.slug })
				.from(posts)
				.where(and(eq(posts.id, trackedId), eq(posts.lang, lang), visiblePostCondition(now)))
				.limit(1);
			if (target && target.slug !== slug) {
				// Preserve the original query string (tracking params etc.) — the
				// bare-path redirect dropped it.
				redirect(
					301,
					localizeHref(`/posts/${target.slug}${url.search}`, {
						locale: lang as (typeof locales)[number]
					})
				);
			}
		}

		const others = await db
			.selectDistinct({ lang: posts.lang })
			.from(posts)
			.where(and(eq(posts.slug, slug), ne(posts.lang, lang), visiblePostCondition(now)));

		const order = locales as readonly string[];
		if (others.length > 0) {
			const available = [...new Set(others.map((other) => other.lang))]
				.filter((tag) => order.includes(tag))
				.sort((a, b) => order.indexOf(a) - order.indexOf(b))
				.map((tag) => ({
					lang: tag,
					href: localizeHref(`/posts/${slug}`, { locale: tag as (typeof locales)[number] })
				}));
			error(404, {
				message: m.error_post_language_hint(),
				available
			});
		}
		error(404, 'Not found');
	}

	// hreflang set: every visible language of the same translation
	// group, in locale order — self included; x-default stays deferred.
	const localeOrder = locales as readonly string[];
	const sourceId = row.translatedFromPostId;
	const needsSource = Boolean(sourceId) && (row.writingOrigin == null || row.aiHelp == null);
	// The source lookup depends only on `row`, so run it alongside the hreflang
	// query instead of adding a second sequential round trip on translated
	// pages. Visibility is part of the lookup: provenance is public disclosure,
	// so a hidden source must not leak its claims into a live translation.
	const sourcePromise =
		needsSource && sourceId
			? db
					.select({
						writingOrigin: posts.writingOrigin,
						aiHelp: posts.aiHelp
					})
					.from(posts)
					.where(
						and(
							eq(posts.id, sourceId),
							eq(posts.translationGroup, row.translationGroup),
							visiblePostCondition(now)
						)
					)
					.limit(1)
			: Promise.resolve([]);
	const [siblings, sourceRows] = await Promise.all([
		db
			.select({
				id: posts.id,
				lang: posts.lang,
				slug: posts.slug,
				translatedFromPostId: posts.translatedFromPostId
			})
			.from(posts)
			.where(and(eq(posts.translationGroup, row.translationGroup), visiblePostCondition(now))),
		sourcePromise
	]);
	const tagRows = await db
		.select({ name: tags.name })
		.from(postTags)
		.innerJoin(tags, eq(postTags.tagId, tags.id))
		.where(inArray(postTags.postId, [row.id]))
		.orderBy(tags.name);
	const ordered = siblings
		.filter((sibling) => localeOrder.includes(sibling.lang))
		.sort((a, b) => localeOrder.indexOf(a.lang) - localeOrder.indexOf(b.lang));
	const alternates = ordered.map((sibling) => ({
		lang: sibling.lang,
		path: `/posts/${sibling.slug}`
	}));
	// The group's source is the member nothing else was translated from. A
	// malformed group without one simply carries no "original" marker.
	const sourceRowId = ordered.find((sibling) => sibling.translatedFromPostId === null)?.id ?? null;
	const translations = ordered.map((sibling) => ({
		lang: sibling.lang,
		path: `/posts/${sibling.slug}`,
		isSource: sibling.id === sourceRowId
	}));

	// Translations inherit the source row's writing disclosure: the translated
	// text is not a new claim about who wrote the original. The translation
	// origin stays on this row (it describes this rendition); it is meaningless
	// on a source row, so the public payload omits it there.
	const provenance = {
		writingOrigin: row.writingOrigin,
		aiHelp: row.aiHelp?.length ? row.aiHelp : null,
		translationOrigin: sourceId ? row.translationOrigin : null,
		isTranslation: Boolean(sourceId)
	};
	if (needsSource) {
		const source = sourceRows[0] as
			{ writingOrigin: string | null; aiHelp: string[] | null } | undefined;
		const writingInherited = provenance.writingOrigin == null;
		provenance.writingOrigin ??= source?.writingOrigin ?? null;
		// Only inherit the detail when the effective writing claim is AI-assisted;
		// an explicit "none" must not receive the source's "where AI helped".
		if (provenance.aiHelp == null && (writingInherited || provenance.writingOrigin === 'assist')) {
			provenance.aiHelp = source?.aiHelp?.length ? source.aiHelp : null;
		}
	}
	// The detail is only part of the public payload when the page can attribute
	// it to an AI-assisted claim; never ship a contradictory array with "No AI".
	if (
		!['assist', 'mostly_ai', 'ai_full'].includes(provenance.writingOrigin ?? '') ||
		!provenance.aiHelp?.length
	) {
		provenance.aiHelp = null;
	}

	// Viewer state for the comment section: guests get the login link with a return
	// path to this localized URL; signed-in readers need a verified email to submit.
	// The site-wide switch can only narrow the per-post row — new comments need both,
	// while existing approved rows stay readable either way.
	const user = locals.user;
	const emailVerified = Boolean(user?.emailVerified);
	const commentsEnabled = await getOption('comments.enabled');
	// Country labels need the whole chain on (privacy + collect + show). The page
	// passes the flag to the assembly instead of letting the component guess.
	const privacy = await getOption('comments.privacy');
	const showCountry = privacy.enabled && privacy.collectCountry && privacy.showCountry;
	const commentsOpen = commentsEnabled && row.allowComment;
	const canComment = Boolean(user) && emailVerified && commentsOpen;
	const loginUrl = user
		? null
		: `/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`;

	// The comment read path always owns rendering when either side allows authoring
	// or rows already exist: closed threads keep their approved comments visible and
	// segment anchors stay resolved. A closed post with zero comments returns null so
	// the section does not shout "0".
	const rendered = await renderDiscussion({
		markdown: row.content ?? '',
		targetType: 'post',
		targetId: row.id,
		viewerId: user?.id ?? null,
		showCountry
	});
	const html = rendered.html;

	return {
		seo: {
			path: `/posts/${row.slug}`,
			alternates
		},
		post: {
			id: row.id,
			slug: row.slug,
			lang: row.lang,
			title: row.title,
			summary: row.summary?.trim() || null,
			summaryAi: Boolean(row.summaryAi),
			date: row.publishedAt ? formatDate(row.publishedAt) : '',
			category: resolveTaxonomyName(
				{
					name: row.categoryName,
					nameI18n: row.categoryNameI18n,
					sourceLang: row.categorySourceLang
				},
				lang
			),
			tags: [...new Set(tagRows.map((tag) => tag.name))],
			views: row.readCount,
			likes: row.likeCount,
			updatedAt: row.updatedAt,
			translations,
			edited:
				row.updatedAt != null &&
				row.publishedAt != null &&
				row.updatedAt.getTime() - row.publishedAt.getTime() > 60_000
		},
		provenance,
		html,
		viewer: {
			emailVerified,
			canComment,
			loginUrl,
			privacyNotice: true,
			commentsClosed: !commentsOpen,
			countryOptIn: showCountry
		},
		discussion: commentsOpen || rendered.discussion.visibleCount > 0 ? rendered.discussion : null
	};
};

/**
 * Shared submit path for the two named actions. The target is resolved from
 * the URL slug server-side (a client-supplied id is never trusted); the
 * service re-validates visibility, the thread switch and the parent row
 * authoritatively.
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
	const targetId = await resolveCommentPostTarget(lang, event.params.slug, now);
	if (!targetId) return fail(404, { message: m.comment_error_unavailable() });

	// Anchors belong to roots: replies never carry one, even if the
	// form smuggles the fields in.
	const anchorRead = isReply ? ({ kind: 'none' } as const) : readCommentAnchorDraft(form);
	if (anchorRead.kind === 'invalid') return fail(400, { message: m.comment_error_generic() });

	const profile = event.locals.profile;
	const result = await submitComment({
		targetType: 'post',
		targetId,
		lang,
		parentId,
		anchor: anchorRead.kind === 'ok' ? anchorRead.draft : null,
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
