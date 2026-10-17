/**
 * Shared view contract for the comment thread components (comment P3a, spec
 * §10): the shape `services/comments.ts#loadThreads` assembles and the mount
 * (posts today; notes/pages with their batches) passes down. Deliberately
 * outside `$lib/server` so client components can import it directly.
 */
export type CommentTargetType = 'post' | 'note' | 'page';

/**
 * Comment text bound (spec §1), shared so the server-side validation and the
 * composer's `maxlength` cannot drift apart.
 */
export const COMMENT_MAX_LENGTH = 2000;

export interface CommentView {
	id: string;
	text: string;
	author: string | null;
	avatar: string | null;
	isOwner: boolean;
	isPending: boolean;
	createdAt: Date;
	/** Non-null once the author edited the text - drives the "已编辑" marker. */
	editedAt: Date | null;
	/** The signed-in viewer authored this comment (edit/delete entries). */
	isMine: boolean;
}

export interface ThreadReply extends CommentView {
	/** "回复 @作者" chip target; null when the parent is the root or hidden. */
	replyToAuthor: string | null;
}

/**
 * Segment-anchor view data (comment P3b). Display-only: the stored payload
 * (hash/occ/ord/range/exact/prefix/suffix) never leaves the server — the page
 * carries just what the list and the deep link need.
 */
export interface CommentAnchorView {
	/** Quote chip text, already capped in code points (spec §8). */
	quote: string;
	/** False when resolution failed -> the root moves to the folded orphan area. */
	orphaned: boolean;
	/** The `#c-…` id actually rendered (a cluster representative), null if none. */
	targetId: string | null;
}

export interface ThreadRoot extends CommentView {
	pin: boolean;
	isDeleted: boolean;
	/** Segment anchor, or null for an article-level comment (spec §2). */
	anchor: CommentAnchorView | null;
	/** Visible replies only, in display order. */
	replies: ThreadReply[];
}

export interface ThreadsPage {
	/** Article-level roots plus roots whose anchor resolved, in display order. */
	roots: ThreadRoot[];
	/**
	 * Roots whose anchor no longer resolves (folded "original text changed"
	 * area). Optional so a producer that predates P3b still renders: the
	 * section derives 0 / [] instead of crashing on `undefined.length`.
	 */
	orphans?: ThreadRoot[];
	visibleCount: number;
	orphanCount?: number;
	truncated: boolean;
}

/** Shape of the comment form action result surfaced to the section. */
export interface CommentFormState {
	submitted?: 'pending' | 'approved';
	message?: string;
	/** Soft-delete success flash (P4). */
	deleted?: boolean;
}
