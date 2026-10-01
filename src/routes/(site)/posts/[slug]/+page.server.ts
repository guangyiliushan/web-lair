import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import { getLocale, localizeHref, locales } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { requireUser } from '$lib/server/authz';
import {
	loadThreads,
	resolveCommentPostTarget,
	submitComment
} from '$lib/server/services/comments';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { findSlugTargetId } from '$lib/server/services/slug-resolver';
import { formatDate } from '$lib/utils/i18n';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * Public post detail (P3-a read side + comment P3a threads): the post must
 * exist in the URL's locale and pass the shared visibility condition. A
 * missing language version is a 404 with a hint listing the languages that do
 * have the same slug — never an automatic fallback (ledger §9.16.5). A retired slug resolves through
 * slug_trackers with a single 301 hop (P3-b).
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
			title: posts.title,
			content: posts.content,
			publishedAt: posts.publishedAt,
			categoryName: categories.name,
			allowComment: posts.allowComment
		})
		.from(posts)
		.innerJoin(categories, eq(posts.categoryId, categories.id))
		.where(and(eq(posts.lang, lang), eq(posts.slug, slug), visiblePostCondition(now)))
		.limit(1);

	if (!row) {
		// Slug fallback chain (P3-b, ledger §9.16.5): a retired slug resolves
		// through slug_trackers (single hop — trackers point at the row id, so
		// chains cannot form). An invisible, missing or self-referencing target
		// is a plain 404: never redirect into hidden content or a loop.
		const trackedId = await findSlugTargetId('post', lang, slug);
		if (trackedId) {
			const [target] = await db
				.select({ slug: posts.slug })
				.from(posts)
				.where(and(eq(posts.id, trackedId), eq(posts.lang, lang), visiblePostCondition(now)))
				.limit(1);
			if (target && target.slug !== slug) {
				redirect(
					301,
					localizeHref(`/posts/${target.slug}`, { locale: lang as (typeof locales)[number] })
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
				message: 'This post is not available in this language',
				available
			});
		}
		error(404, 'Not found');
	}

	const html = row.content ? await renderMarkdownToHtml(row.content) : '';

	// Viewer state for the comment section (spec §1 "已验证读者"): guests get
	// the login link with a return path to this localized URL; signed-in
	// readers need a verified email before they can submit.
	const user = locals.user;
	const emailVerified = Boolean(user?.emailVerified);
	const canComment = Boolean(user) && emailVerified && row.allowComment;
	const loginUrl = user
		? null
		: `/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`;

	return {
		post: {
			slug: row.slug,
			title: row.title,
			date: row.publishedAt ? formatDate(row.publishedAt) : '',
			category: row.categoryName
		},
		html,
		viewer: { emailVerified, canComment, loginUrl },
		discussion: row.allowComment
			? await loadThreads({
					targetType: 'post',
					targetId: row.id,
					viewerId: user?.id ?? null
				})
			: null
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

	const profile = event.locals.profile;
	const result = await submitComment({
		targetType: 'post',
		targetId,
		lang,
		parentId,
		text,
		user,
		author: profile?.displayName ?? user.name ?? 'Reader',
		avatar: profile?.avatarUrl ?? user.image ?? null,
		now
	});

	switch (result.kind) {
		case 'created':
			return { submitted: result.state };
		case 'throttled':
			return fail(429, { message: m.comment_throttled() });
		case 'unverified':
			return fail(403, { message: m.comment_verify_hint() });
		case 'empty':
		case 'too-long':
		case 'unsupported-target':
			return fail(400, { message: m.comment_error_generic() });
		case 'parent-unavailable':
			return fail(400, { message: m.comment_error_parent() });
		case 'target-unavailable':
			return fail(404, { message: m.comment_error_unavailable() });
	}
}

export const actions = {
	comment: (event) => handleSubmit(event, false),
	reply: (event) => handleSubmit(event, true)
} satisfies Actions;
