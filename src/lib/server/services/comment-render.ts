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
	let renderedTree = tree;
	let threads: ThreadsPage;
	try {
		const blocks = collectAnchorBlocks(tree);
		const loaded = await loadDiscussion({
			targetType: input.targetType,
			targetId: input.targetId,
			viewerId: input.viewerId,
			blocks
		});
		threads = loaded.threads;
		if (loaded.marks.length > 0) {
			// Identical ranges share one span, so several comments can point at
			// the same cluster representative; unplaced resolved anchors become
			// orphans.
			finalizeAnchorTargets(threads, applyAnchorMarks(blocks, loaded.marks), {
				targetType: input.targetType,
				targetId: input.targetId
			});
		}
	} catch (caught) {
		// A resolver invariant must never 500 the whole article: render the body
		// without marks and let anchored roots land in the orphan fold, which is
		// visible and recoverable (B1 review, angle 4). Log identity, never the
		// error object: drizzle errors embed SQL and bound params (comment text).
		console.error('[comments] segment pipeline failed; rendering without marks', {
			targetType: input.targetType,
			targetId: input.targetId,
			name: caught instanceof Error ? caught.name : 'unknown'
		});
		// applyAnchorMarks mutates the tree in place: a throw mid-pass leaves
		// partial spans behind, so re-render before serializing.
		renderedTree = await renderMarkdownTree(input.markdown);
		threads = (
			await loadDiscussion({
				targetType: input.targetType,
				targetId: input.targetId,
				viewerId: input.viewerId,
				blocks: []
			})
		).threads;
	}

	return { html: await stringifyMarkdownTree(renderedTree), discussion: threads };
}
