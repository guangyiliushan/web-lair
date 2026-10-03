import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getLocale, localizeHref, locales } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { db } from '$lib/server/db';
import { notes } from '$lib/server/db/content';
import { requireUser } from '$lib/server/authz';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { getOption } from '$lib/server/config/options-registry';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { loadThreads, submitComment } from '$lib/server/services/comments';
import {
	findVisibleNote,
	getNoteBody,
	getNoteGateRecord,
	getNoteMeta,
	listVisibleGroupVersions,
	listVisibleNoteLanguages,
	type NoteUnlockedMeta
} from '$lib/server/services/notes';
import { visibleNoteCondition } from '$lib/server/services/note-visibility';
import {
	noteGateTtlSeconds,
	noteUnlockCookieName,
	NOTE_GATE_RATE_LIMIT,
	signNoteUnlockToken,
	verifyNotePassword,
	verifyNoteUnlockToken
} from '$lib/server/services/note-gate';
import { findSlugTargetId } from '$lib/server/services/slug-resolver';
import { noteDateLabel } from '$lib/utils/note-date';
import type { Cookies } from '@sveltejs/kit';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * Public note detail (N1): the row must exist in the URL's locale and pass
 * the shared visibility condition. A retired slug resolves through
 * slug_trackers with one 301 hop (P3-b resolver; visibility re-checked on
 * the target). A missing language version 404s with a hint listing the
 * languages that do have the slug - never an automatic fallback.
 *
 * Password-gated rows render the public shell (title + gate form) only;
 * `findVisibleNote` already withholds body AND diary metadata, and the body
 * is re-read through `getNoteBody` only after the unlock cookie verifies.
 */
export const load: PageServerLoad = async ({ cookies, locals, params, url }) => {
	const lang = getLocale();
	const { slug } = params;
	// One timestamp for both visibility checks (mirrors the posts detail
	// page): a boundary row cannot be hidden here yet listed as available
	// in the hint query.
	const now = new Date();
	const siteTz = await getOption('site.timezone');

	const note = await findVisibleNote(lang, slug, now);
	if (!note) {
		// Slug fallback chain: a retired slug resolves through slug_trackers
		// (single hop - trackers point at the row id). An invisible, missing
		// or self-referencing target is a plain 404: never redirect into
		// hidden content or a loop.
		const trackedId = await findSlugTargetId('note', lang, slug);
		if (trackedId) {
			const [target] = await db
				.select({ slug: notes.slug })
				.from(notes)
				.where(and(eq(notes.id, trackedId), eq(notes.lang, lang), visibleNoteCondition(now)))
				.limit(1);
			if (target && target.slug !== slug) {
				// Preserve the original query string (tracking params etc.).
				redirect(
					301,
					localizeHref(`/notes/${target.slug}${url.search}`, {
						locale: lang as (typeof locales)[number]
					})
				);
			}
		}

		const others = await listVisibleNoteLanguages(slug, lang, now);
		const order = locales as readonly string[];
		if (others.length > 0) {
			const available = [...new Set(others)]
				.filter((tag) => order.includes(tag))
				.sort((a, b) => order.indexOf(a) - order.indexOf(b))
				.map((tag) => ({
					lang: tag,
					href: localizeHref(`/notes/${slug}`, { locale: tag as (typeof locales)[number] })
				}));
			error(404, { message: m.error_note_language_hint(), available });
		}
		error(404, 'Not found');
	}

	// Unlock state: the cookie token is verified against the CURRENT stored
	// hash, so a password change revokes it. Verified unlocks re-read the
	// body AND the diary metadata server-side - the SSR page then carries the
	// decrypted diary (body-only re-reads used to leave mood/weather/...
	// missing forever; review finding).
	let unlocked = false;
	let unlockedBody: string | null = null;
	let unlockedMeta: NoteUnlockedMeta | null = null;
	if (note.locked) {
		unlocked = await isUnlockVerified(cookies, note.id, now);
		if (unlocked) {
			[unlockedBody, unlockedMeta] = await Promise.all([
				getNoteBody(note.id),
				getNoteMeta(note.id)
			]);
		}
	}

	const body = note.locked ? (unlocked ? (unlockedBody ?? '') : '') : (note.content ?? '');
	// Locked-but-not-unlocked rows keep every field withheld (findVisibleNote
	// already nulled them); unlocked rows read them from the verified pass.
	const meta: NoteUnlockedMeta | null = note.locked
		? unlockedMeta
		: {
				tz: note.tz,
				mood: note.mood,
				emotions: note.emotions,
				weatherCode: note.weatherCode,
				temperatureC: note.temperatureC,
				coordinates: note.coordinates,
				location: note.location
			};
	const html = body ? await renderMarkdownToHtml(body) : '';

	// hreflang set: every visible language of the translation group, in
	// locale order - self included; x-default stays deferred.
	const localeOrder = locales as readonly string[];
	const siblings = await listVisibleGroupVersions(note.translationGroup, now);
	const alternates = siblings
		.filter((sibling) => localeOrder.includes(sibling.lang))
		.sort((a, b) => localeOrder.indexOf(a.lang) - localeOrder.indexOf(b.lang))
		.map((sibling) => ({ lang: sibling.lang, path: `/notes/${sibling.slug}` }));

	// Viewer state for the comment section: guests get a login link with a
	// return path; gated rows only render the section after an unlock.
	const user = locals.user;
	const emailVerified = Boolean(user?.emailVerified);
	const open = !note.locked || unlocked;
	const canComment = Boolean(user) && emailVerified && note.allowComment && open;
	const loginUrl = user
		? null
		: `/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`;

	return {
		seo: { path: `/notes/${note.slug}`, alternates },
		note: {
			slug: note.slug,
			title: note.title,
			date: noteDateLabel(note.publishedAt, meta?.tz ?? null, siteTz),
			mood: meta?.mood ?? null,
			emotions: meta?.emotions ?? null,
			weatherCode: meta?.weatherCode ?? null,
			temperatureC: meta?.temperatureC ?? null,
			location: meta?.location ?? null,
			pinAt: note.pinAt,
			topic: note.topic
		},
		html,
		gate: { locked: note.locked, unlocked },
		viewer: { emailVerified, canComment, loginUrl },
		discussion:
			note.allowComment && open
				? await loadThreads({ targetType: 'note', targetId: note.id, viewerId: user?.id ?? null })
				: null
	};
};

function clientIp(event: RequestEvent): string {
	try {
		return event.getClientAddress() ?? '';
	} catch {
		return '';
	}
}

/**
 * Verify this request's unlock cookie for one row against the CURRENT stored
 * hash (a password change revokes outstanding unlocks). Shared by the page
 * load and the comment actions so both layers agree on what "unlocked"
 * means.
 */
async function isUnlockVerified(cookies: Cookies, noteId: string, now: Date): Promise<boolean> {
	const token = cookies.get(noteUnlockCookieName(noteId));
	if (!token) return false;
	const gate = await getNoteGateRecord(noteId);
	return Boolean(
		gate?.passwordHash && verifyNoteUnlockToken(noteId, gate.passwordHash, token, now)
	);
}

/**
 * Unlock action: the password is verified against the stored hash, then an
 * HMAC-signed cookie is set for this row only. The rate limit counts FAILED
 * attempts (a correct password never eats the budget) and shares the
 * platform limiter's fail-open contract.
 */
async function handleUnlock(event: RequestEvent) {
	const lang = getLocale();
	const { slug } = event.params;
	const now = new Date();
	const note = await findVisibleNote(lang, slug, now);
	if (!note || !note.locked) return fail(404, { message: m.notes_unlock_unavailable() });

	const form = await event.request.formData();
	const password = form.get('password')?.toString() ?? '';
	const gate = await getNoteGateRecord(note.id);

	if (!gate?.passwordHash || !(await verifyNotePassword(password, gate.passwordHash))) {
		const rate = await rateLimit(
			getCache(),
			`limits:note-gate:${clientIp(event)}`,
			NOTE_GATE_RATE_LIMIT.limit,
			NOTE_GATE_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) return fail(429, { message: m.notes_unlock_limited() });
		if (rate.count === 0) {
			// rateLimit() fail-open signature (the store threw): deliberate
			// per the platform contract, but never silently.
			console.warn('[note-gate] rate limiter store unavailable; failing open');
		}
		return fail(403, { message: m.notes_unlock_wrong() });
	}

	const ttlSeconds = await noteGateTtlSeconds();
	const token = signNoteUnlockToken(
		note.id,
		gate.passwordHash,
		Math.floor(now.getTime() / 1000) + ttlSeconds
	);
	event.cookies.set(noteUnlockCookieName(note.id), token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: event.url.protocol === 'https:',
		maxAge: ttlSeconds
	});
	// The browser replaces the document query with the action suffix
	// (`?/unlock`), so event.url.search is never the original query - redirect
	// to the clean canonical URL (review finding: a dirty `?/unlock` used to
	// land in the address bar).
	redirect(
		303,
		localizeHref(`/notes/${note.slug}`, {
			locale: lang as (typeof locales)[number]
		})
	);
}

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

	const now = new Date();
	const lang = getLocale();
	// Resolve the target ourselves so the gate state is known before the
	// service re-validates: an unlocked gated row is commentable (spec §7),
	// everything else stays fail-closed.
	const note = await findVisibleNote(lang, event.params.slug, now);
	if (!note) return fail(404, { message: m.comment_error_unavailable() });
	const unlockVerified = !note.locked || (await isUnlockVerified(event.cookies, note.id, now));
	if (!unlockVerified) return fail(404, { message: m.comment_error_unavailable() });

	const profile = event.locals.profile;
	const result = await submitComment({
		targetType: 'note',
		targetId: note.id,
		lang,
		unlockVerified,
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
	unlock: handleUnlock,
	comment: (event) => handleSubmit(event, false),
	reply: (event) => handleSubmit(event, true)
} satisfies Actions;
