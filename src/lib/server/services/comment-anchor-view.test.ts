import { describe, expect, it, vi } from 'vitest';
import type { ThreadRoot, ThreadsPage } from '$lib/components/comments/types';
import { finalizeAnchorTargets } from './comment-anchor-view';

/**
 * The "resolved but no span" state (comment P3b, grill G4): a chip must never
 * point nowhere. This is the only place that decides between "jump to source",
 * "orphaned" and "untouched".
 */
function root(id: string, anchor: ThreadRoot['anchor']): ThreadRoot {
	return {
		id,
		text: 'comment',
		author: 'A',
		avatar: null,
		isOwner: false,
		isPending: false,
		createdAt: new Date('2026-10-17T10:00:00Z'),
		editedAt: null,
		isMine: false,
		pin: false,
		isDeleted: false,
		anchor,
		replies: []
	};
}

function page(roots: ThreadRoot[], orphans: ThreadRoot[] = []): ThreadsPage {
	return {
		roots,
		orphans,
		visibleCount: roots.length,
		orphanCount: orphans.length,
		truncated: false
	};
}

describe('finalizeAnchorTargets', () => {
	it('fills the placed id and leaves the chip followable', () => {
		const threads = page([root('c1', { quote: 'q', orphaned: false, targetId: null })]);
		finalizeAnchorTargets(threads, new Map([['c1', 'c-c1']]));
		expect(threads.roots[0].anchor).toMatchObject({ targetId: 'c-c1', orphaned: false });
	});

	it('degrades a resolved-but-unplaced anchor to article-level (never a dead chip)', () => {
		// R-5(a): the text did not change - this is our mapping failing, so the
		// reader must not be told "original text changed", and must not get a chip
		// that leads nowhere. Degrade + warn so the bug stays visible in logs.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const threads = page([root('c1', { quote: 'q', orphaned: false, targetId: null })]);
		finalizeAnchorTargets(threads, new Map([['c1', null]]));
		expect(threads.roots[0].anchor).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			'[comments] anchor resolved but no span was placed; degrading to article-level',
			expect.objectContaining({ commentId: 'c1' })
		);
		warn.mockRestore();
	});

	it('leaves article-level comments and already-orphaned roots untouched', () => {
		const threads = page(
			[root('plain', null)],
			[root('orphan', { quote: 'q', orphaned: true, targetId: null })]
		);
		finalizeAnchorTargets(threads, new Map());
		expect(threads.roots[0].anchor).toBeNull();
		expect(threads.orphans?.[0].anchor).toMatchObject({ orphaned: true, targetId: null });
	});

	it('clusters: two comments on one range share the representative id', () => {
		const threads = page([
			root('c1', { quote: 'q', orphaned: false, targetId: null }),
			root('c2', { quote: 'q', orphaned: false, targetId: null })
		]);
		finalizeAnchorTargets(
			threads,
			new Map([
				['c1', 'c-c1'],
				['c2', 'c-c1']
			])
		);
		expect(threads.roots.map((item) => item.anchor?.targetId)).toEqual(['c-c1', 'c-c1']);
	});
});
