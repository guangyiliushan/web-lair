/**
 * Admin comment-queue target display (comment P3a, spec §9): resolve the
 * exclusive-arc target of a queue row into a type label, a human title and a
 * best-effort front link. Pure so all three target kinds and the fallback
 * orders have unit teeth before notes/pages even produce rows.
 */
export type CommentTargetKind = 'post' | 'note' | 'page';

export interface CommentTargetRow {
	postId: string | null;
	postTitle: string | null;
	postSlug: string | null;
	noteId: string | null;
	noteTitle: string | null;
	noteSlug: string | null;
	pageId: string | null;
	pageTitle: Partial<Record<string, string>> | null;
	pageSlug: string | null;
}

export interface CommentTargetDisplay {
	kind: CommentTargetKind;
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

/** Locale fallback order for the pages jsonb title (matches the site order). */
const TEXT_LOCALES = ['en', 'zh-cn', 'ja'] as const;

function firstText(value: Partial<Record<string, string>> | null): string | null {
	if (!value) return null;
	for (const locale of TEXT_LOCALES) {
		const text = value[locale];
		if (text) return text;
	}
	return null;
}

export function commentTargetDisplay(entry: CommentTargetRow): CommentTargetDisplay | null {
	if (entry.postId) {
		return {
			kind: 'post',
			label: LABELS.post,
			title: entry.postTitle ?? entry.postSlug ?? '（未知）',
			href: entry.postSlug ? `/posts/${entry.postSlug}` : null
		};
	}
	if (entry.noteId) {
		return {
			kind: 'note',
			label: LABELS.note,
			title: entry.noteTitle ?? entry.noteSlug ?? '（未知）',
			href: entry.noteSlug ? `/notes/${entry.noteSlug}` : null
		};
	}
	if (entry.pageId) {
		return {
			kind: 'page',
			label: LABELS.page,
			title: firstText(entry.pageTitle) ?? entry.pageSlug ?? '（未知）',
			href: entry.pageSlug ? `/${entry.pageSlug}` : null
		};
	}
	return null;
}
