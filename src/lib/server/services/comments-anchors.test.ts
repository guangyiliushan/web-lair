import { describe, expect, it } from 'vitest';
import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { collectAnchorBlocks } from '$lib/server/comment-anchor';
import { assembleDiscussion, type CommentRow } from './comments';

/* ── fixtures ───────────────────────────────────────────────────────────── */

const text = (value: string): ElementContent => ({ type: 'text', value });
const el = (tagName: string, children: ElementContent[]): Element => ({
	type: 'element',
	tagName,
	properties: {},
	children
});
const tree = (...blocks: ElementContent[]): HastRoot => ({ type: 'root', children: blocks });

function row(overrides: Partial<CommentRow> = {}): CommentRow {
	return {
		id: 'root-1',
		text: 'comment text',
		author: 'Alice',
		avatar: null,
		state: 'approved',
		isDeleted: false,
		isOwnerReply: false,
		pin: false,
		createdAt: new Date('2026-10-17T10:00:00Z'),
		parentCommentId: null,
		rootCommentId: null,
		editedAt: null,
		readerId: null,
		anchor: null,
		...overrides
	};
}

function anchorFor(blocks: ReturnType<typeof collectAnchorBlocks>, phrase: string) {
	const block = blocks.find((candidate) => candidate.text.includes(phrase));
	if (!block) throw new Error(`no block contains ${phrase}`);
	const start = [...block.text.slice(0, block.text.indexOf(phrase))].length;
	const end = start + [...phrase].length;
	return {
		v: 1 as const,
		lang: 'en',
		block: { hash: block.hash, occ: block.occ, ord: block.ord },
		range: { start, end },
		quote: { exact: phrase, prefix: '', suffix: '' }
	};
}

const body = () => tree(el('p', [text('First paragraph.')]), el('p', [text('Second paragraph.')]));

/* ── read assembly ──────────────────────────────────────────────────────── */

describe('assembleDiscussion (comment P3b read side)', () => {
	it('keeps a resolved anchor in the main list and emits a mark', () => {
		const blocks = collectAnchorBlocks(body());
		const anchor = anchorFor(blocks, 'Second');
		const { threads, marks } = assembleDiscussion([row({ anchor })], [], {
			blocks,
			viewerId: null
		});

		expect(threads.roots).toHaveLength(1);
		expect(threads.orphans).toHaveLength(0);
		expect(threads.visibleCount).toBe(1);
		expect(threads.orphanCount).toBe(0);
		expect(threads.roots[0].anchor).toEqual({
			quote: 'Second',
			orphaned: false,
			targetId: null
		});
		expect(marks).toHaveLength(1);
		expect(marks[0]).toMatchObject({
			commentId: 'root-1',
			blockOrd: blocks[1].ord,
			pending: false
		});
	});

	it('moves an unresolved anchor to the folded area with its replies', () => {
		const blocks = collectAnchorBlocks(body());
		const missing = 'text that no longer exists';
		const stale = {
			...anchorFor(blocks, 'Second'),
			range: { start: 0, end: [...missing].length },
			quote: { exact: missing, prefix: '', suffix: '' }
		};
		const reply = row({
			id: 'reply-1',
			parentCommentId: 'root-1',
			rootCommentId: 'root-1',
			text: 'a reply'
		});
		const { threads, marks } = assembleDiscussion([row({ anchor: stale })], [reply], { blocks });

		const orphans = threads.orphans ?? [];
		expect(threads.roots).toHaveLength(0);
		expect(orphans).toHaveLength(1);
		expect(orphans[0].anchor?.orphaned).toBe(true);
		expect(orphans[0].anchor?.quote).toBe('text that no longer exists');
		expect(orphans[0].replies).toHaveLength(1);
		// Own count: the orphan root plus its visible reply.
		expect(threads.orphanCount).toBe(2);
		expect(threads.visibleCount).toBe(0);
		expect(marks).toHaveLength(0);
	});

	it('treats an article-level comment as an anchor-less root', () => {
		const { threads, marks } = assembleDiscussion([row()], [], {
			blocks: collectAnchorBlocks(body())
		});
		expect(threads.roots[0].anchor).toBeNull();
		expect(marks).toHaveLength(0);
	});

	it('keeps the mark of a deleted root that still holds the floor', () => {
		const blocks = collectAnchorBlocks(body());
		const anchor = anchorFor(blocks, 'First');
		const reply = row({ id: 'reply-1', parentCommentId: 'root-1', rootCommentId: 'root-1' });
		const { threads, marks } = assembleDiscussion([row({ anchor, isDeleted: true })], [reply], {
			blocks
		});
		expect(threads.roots[0].isDeleted).toBe(true);
		expect(threads.roots[0].text).toBe('');
		// The passage text stays in the article; the placeholder no longer ships
		// its historical quote (payload hygiene, B1 review angle 4).
		expect(threads.roots[0].anchor).toBeNull();
		expect(marks).toHaveLength(1);
	});

	it('orphans anchored rows when the caller has no block directory (article-level read)', () => {
		const blocks = collectAnchorBlocks(body());
		const anchor = anchorFor(blocks, 'First');
		const { threads } = assembleDiscussion([row({ anchor })], []);
		expect(threads.roots).toHaveLength(0);
		expect(threads.orphans).toHaveLength(1);
	});

	it('marks the viewer own pending comment as pending', () => {
		const blocks = collectAnchorBlocks(body());
		const anchor = anchorFor(blocks, 'First');
		const { marks } = assembleDiscussion([row({ anchor, state: 'pending' })], [], {
			blocks,
			viewerId: 'reader-1'
		});
		expect(marks[0].pending).toBe(true);
	});

	it('never exposes the stored payload through the view model', () => {
		const blocks = collectAnchorBlocks(body());
		const anchor = anchorFor(blocks, 'First');
		const { threads } = assembleDiscussion([row({ anchor })], [], { blocks });
		const serialized = JSON.stringify(threads);
		// Spec §7: hash/occ/ord/range/prefix/suffix stay server-side; the page only
		// gets the display quote and the rendered target id.
		expect(serialized).not.toContain('"hash"');
		expect(serialized).not.toContain('"occ"');
		expect(serialized).not.toContain('"prefix"');
		expect(serialized).not.toContain('"range"');
	});

	it('ignores malformed stored anchors instead of throwing', () => {
		const { threads } = assembleDiscussion([row({ anchor: { v: 2 } })], [], {
			blocks: collectAnchorBlocks(body())
		});
		expect(threads.roots[0].anchor).toBeNull();
	});
});
