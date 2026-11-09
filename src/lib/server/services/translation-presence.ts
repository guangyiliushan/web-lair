import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { drafts, notes, posts } from '$lib/server/db/content';

/**
 * The single "usable translation" predicate every reader shares. A target row
 * counts as a translation only when it is published/scheduled or carries
 * content, either on the row itself or in its working draft - rows left empty
 * by a failed generation must not block a retry.
 */
export type TranslationPresenceEntry = {
	postId: string;
	status: 'draft' | 'private' | 'scheduled' | 'published' | 'trash';
	hasContent: boolean;
};

type PresenceRow = {
	postId: string;
	lang: string;
	status: string;
	content: string | null;
	draftContent: string | null;
};

function hasText(value: string | null): boolean {
	return (value ?? '').trim() !== '';
}

export function isUsable(status: string, hasContent: boolean): boolean {
	return status === 'published' || status === 'scheduled' || hasContent;
}

async function presenceRows(sourceType: 'post' | 'note', group: string): Promise<PresenceRow[]> {
	if (sourceType === 'post') {
		return db
			.select({
				postId: posts.id,
				lang: posts.lang,
				status: posts.status,
				content: posts.content,
				draftContent: drafts.content
			})
			.from(posts)
			.leftJoin(drafts, and(eq(drafts.refType, 'post'), eq(drafts.refId, posts.id)))
			.where(eq(posts.translationGroup, group));
	}
	return db
		.select({
			postId: notes.id,
			lang: notes.lang,
			status: notes.status,
			content: notes.content,
			draftContent: drafts.content
		})
		.from(notes)
		.leftJoin(drafts, and(eq(drafts.refType, 'note'), eq(drafts.refId, notes.id)))
		.where(eq(notes.translationGroup, group));
}

export async function translationPresenceForGroup(
	sourceType: 'post' | 'note',
	group: string
): Promise<Record<string, TranslationPresenceEntry>> {
	const rows = await presenceRows(sourceType, group);
	const presence: Record<string, TranslationPresenceEntry> = {};
	for (const row of rows) {
		presence[row.lang] = {
			postId: row.postId,
			status: row.status as TranslationPresenceEntry['status'],
			hasContent: hasText(row.content) || hasText(row.draftContent)
		};
	}
	return presence;
}

export async function hasUsableTranslation(
	sourceType: 'post' | 'note',
	group: string,
	lang: string
): Promise<boolean> {
	const presence = await translationPresenceForGroup(sourceType, group);
	const entry = presence[lang];
	return entry ? isUsable(entry.status, entry.hasContent) : false;
}
