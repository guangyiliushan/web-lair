/**
 * Shared view contract for the comment thread components (comment P3a, spec
 * §10): the shape `services/comments.ts#loadThreads` assembles and the mount
 * (posts today; notes/pages with their batches) passes down. Deliberately
 * outside `$lib/server` so client components can import it directly.
 */
export type CommentTargetType = 'post' | 'note' | 'page';

export interface CommentView {
	id: string;
	text: string;
	author: string | null;
	avatar: string | null;
	isOwner: boolean;
	isPending: boolean;
	createdAt: Date;
}

export interface ThreadReply extends CommentView {
	/** "回复 @作者" chip target; null when the parent is the root or hidden. */
	replyToAuthor: string | null;
}

export interface ThreadRoot extends CommentView {
	pin: boolean;
	isDeleted: boolean;
	/** Visible replies only (derived at read; reply_count column is not kept). */
	replyCount: number;
	replies: ThreadReply[];
}

export interface ThreadsPage {
	roots: ThreadRoot[];
	visibleCount: number;
	truncated: boolean;
}

/** Shape of the comment form action result surfaced to the section. */
export interface CommentFormState {
	submitted?: 'pending' | 'approved';
	message?: string;
}
