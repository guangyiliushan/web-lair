import { localizeHref, locales } from '$lib/paraglide/runtime';

/**
 * Admin comment-queue target display (comment P3a, spec §9): resolve the
 * exclusive-arc target of a queue row into a type label, a human title and a
 * best-effort front link. Admin-only (the labels are hardcoded Chinese per
 * the admin surface convention) - it lives next to the admin components so
 * site code does not grow a second copy.
 */
export type CommentTargetKind = 'post' | 'note' | 'page';

export interface CommentTargetRow {
	postId: string | null;
	postTitle: string | null;
	postSlug: string | null;
	postLang: string | null;
	noteId: string | null;
	noteTitle: string | null;
	noteSlug: string | null;
	noteLang: string | null;
	pageId: string | null;
	pageTitle: Partial<Record<string, string>> | null;
	pageSlug: string | null;
}

export interface CommentTargetDisplay {
	label: string;
	title: string;
	/** Front link; null when the row has no slug yet (best effort). */
	href: string | null;
}

const LABELS: Record<CommentTargetKind, string> = {
	post: '博文',
	note: '笔记',
	page: '页面'
};

/**
 * Locale fallback order for the pages jsonb title: the repo's language order
 * (paraglide `locales`), so it cannot drift from the site configuration.
 */
function firstText(value: Partial<Record<string, string>> | null): string | null {
	if (!value) return null;
	for (const locale of locales) {
		const text = value[locale];
		if (text) return text;
	}
	return null;
}

/** Keep a short id hint: it is the only manual-location clue for a torn arc. */
function missingTitle(id: string): string {
	return `（未知 · ${id.slice(0, 8)}…）`;
}

/**
 * Content pages resolve (lang, slug): link with the row's own language so the
 * admin cookie locale cannot hijack the target (code review / UI review).
 */
function frontHref(path: string, lang: string | null): string {
	if (lang && (locales as readonly string[]).includes(lang)) {
		return localizeHref(path, { locale: lang as (typeof locales)[number] });
	}
	return path;
}

export function commentTargetDisplay(entry: CommentTargetRow): CommentTargetDisplay | null {
	if (entry.postId) {
		return {
			label: LABELS.post,
			title: entry.postTitle ?? missingTitle(entry.postId),
			href: entry.postSlug ? frontHref(`/posts/${entry.postSlug}`, entry.postLang) : null
		};
	}
	if (entry.noteId) {
		return {
			label: LABELS.note,
			title: entry.noteTitle ?? missingTitle(entry.noteId),
			href: entry.noteSlug ? frontHref(`/notes/${entry.noteSlug}`, entry.noteLang) : null
		};
	}
	if (entry.pageId) {
		return {
			label: LABELS.page,
			title: firstText(entry.pageTitle) ?? missingTitle(entry.pageId),
			href: entry.pageSlug ? `/${entry.pageSlug}` : null
		};
	}
	return null;
}
