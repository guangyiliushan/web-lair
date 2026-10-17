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
export function finalizeAnchorTargets(
	threads: ThreadsPage,
	placed: Map<string, string | null>
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
			console.warn(
				'[comments] anchor resolved but no span was placed; degrading to article-level',
				{ commentId: root.id }
			);
			root.anchor = null;
			continue;
		}
		anchor.targetId = targetId;
	}
}
