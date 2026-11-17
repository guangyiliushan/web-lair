import type { ThreadsPage } from '$lib/components/comments/types';

/**
 * `finalizeAnchorTargets` fills the render-time deep-link target into the view model.
 * A resolved-but-unplaced anchor degrades to article-level with a warning: block coordinates and
 * the node map disagree, so a chip would be a dead link.
 * See `comment-anchor-view.test.ts › "degrades a resolved-but-unplaced anchor to article-level
 * (never a dead chip)"`.
 */
export interface AnchorViewContext {
	targetType?: string;
	targetId?: string;
}

/** One degrade line per (article, comment) per minute, not per render. */
const degradeWarnAt = new Map<string, number>();
function warnDegraded(commentId: string, context: AnchorViewContext): void {
	const key = `${context.targetType ?? '?'}:${context.targetId ?? '?'}:${commentId}`;
	const now = Date.now();
	if (now - (degradeWarnAt.get(key) ?? 0) < 60_000) return;
	if (degradeWarnAt.size > 200) degradeWarnAt.clear();
	degradeWarnAt.set(key, now);
	console.warn('[comments] anchor resolved but no span was placed; degrading to article-level', {
		commentId,
		...context
	});
}

export function finalizeAnchorTargets(
	threads: ThreadsPage,
	placed: Map<string, string | null>,
	context: AnchorViewContext = {}
): void {
	for (const root of [...threads.roots, ...(threads.orphans ?? [])]) {
		const anchor = root.anchor;
		if (!anchor) continue;
		if (anchor.orphaned) {
			// Resolution already failed for this row: it lives in the fold and has
			// no target by definition.
			anchor.targetId = null;
			continue;
		}
		const targetId = placed.get(root.id) ?? null;
		if (targetId === null) {
			warnDegraded(root.id, context);
			root.anchor = null;
			continue;
		}
		anchor.targetId = targetId;
	}
}
