import type { ThreadsPage } from '$lib/components/comments/types';

/**
 * Fill the render-time deep-link target into the view model (comment P3b).
 *
 * A resolved anchor normally gets a placed span; `applyAnchorMarks` returns the
 * id it actually wrote. Three outcomes are possible and only two are states:
 *  - placed            -> chip + "jump to source" link
 *  - resolved, no span -> this is NOT a designed state (block coordinates and
 *    the node map disagree). The text did not change, so calling it "original
 *    text changed" would be a lie; rendering a chip would be a dead link.
 *    Degrade to article-level (`anchor = null`) and keep a warning so the
 *    mapping bug stays visible.
 *  - anchor.orphaned already true -> untouched (folded area).
 *
 * Pure on purpose (types only), so the rule is unit-testable without a database.
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
