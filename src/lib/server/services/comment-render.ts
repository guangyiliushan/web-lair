import type { CommentTargetType, ThreadsPage } from '$lib/components/comments/types';
import { applyAnchorMarks, collectAnchorBlocks } from '$lib/server/comment-anchor';
import { renderMarkdownTree, stringifyMarkdownTree } from '$lib/server/markdown';
import { finalizeAnchorTargets } from './comment-anchor-view';
import { loadDiscussion } from './comments';

/**
 * The single read entry for a commentable body (comment P3b, spec §7).
 *
 * Order matters: the tree is transformed first (sanitize + heading anchors),
 * the block directory is derived from that same tree, threads are resolved
 * against it, marks are applied, and only then is the tree serialized. Doing
 * it anywhere else would either mark against a different tree than the reader
 * sees, or ship the stored anchors to the browser.
 *
 * The three hosts (posts, notes; pages deferred) call this instead of pairing
 * `renderMarkdownToHtml` with `loadThreads`, so the pipeline, the reader and
 * the comment section can never disagree about what a block is.
 */
export interface RenderDiscussionInput {
	markdown: string;
	targetType: CommentTargetType;
	targetId: string;
	/** Signed-in reader id; drives own-pending visibility. */
	viewerId: string | null;
}

export interface RenderedDiscussion {
	html: string;
	discussion: ThreadsPage;
}

export async function renderDiscussion(input: RenderDiscussionInput): Promise<RenderedDiscussion> {
	const tree = await renderMarkdownTree(input.markdown);
	const blocks = collectAnchorBlocks(tree);
	const { threads, marks } = await loadDiscussion({
		targetType: input.targetType,
		targetId: input.targetId,
		viewerId: input.viewerId,
		blocks
	});

	if (marks.length > 0) {
		// Identical ranges share one span, so several comments can point at the
		// same cluster representative; unplaced resolved anchors become orphans.
		finalizeAnchorTargets(threads, applyAnchorMarks(blocks, marks), {
			targetType: input.targetType,
			targetId: input.targetId
		});
	}

	return { html: await stringifyMarkdownTree(tree), discussion: threads };
}
