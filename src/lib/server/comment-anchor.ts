/**
 * Server half of the segment-comment anchor (comment P3b; spec v0.1.3 §2–§7).
 *
 * Three jobs, in pipeline order:
 *  1. `collectAnchorBlocks` — walk the rendered hast tree into an ordered block
 *     directory (normalized text + a code-point -> text-node map). The same
 *     rules live in `$lib/utils/comment-anchor` so the client DOM walker cannot
 *     drift.
 *  2. resolution — read side (hash + quote + ord hint) and write side
 *     (`ord` -> `ord±2` neighbour window -> quote search), per spec §6/§7.
 *  3. `applyAnchorMarks` — wrap resolved ranges in `span.wl-cm` inside the tree,
 *     splitting text nodes and nesting spans per node, then let the caller
 *     stringify. Text must survive byte-for-byte (spec §12.6).
 *
 * The hash lives here (node:crypto) — never in the isomorphic module, so the
 * browser bundle stays free of a second hash implementation.
 */
import { createHash } from 'node:crypto';
import type { Element, ElementContent, Root as HastRoot, Text } from 'hast';
import { z } from 'zod';
import {
	ANCHOR_HASH_HEX_LENGTH,
	ANCHOR_MAX_LENGTH,
	ANCHOR_MIN_LENGTH,
	ANCHOR_PREFIX_MAX,
	ANCHOR_SKIP_WRAPPERS,
	ANCHOR_SUFFIX_MAX,
	ANCHOR_VERSION,
	codePointLength,
	codePointSlice,
	codePointToUtf16,
	foldSegments,
	isAnchorBlock,
	isAnchorSkipped,
	splitsSurrogatePair,
	utf16ToCodePoint,
	type AnchorBlockRef,
	type AnchorElementShape,
	type CommentAnchor,
	type CommentAnchorDraft
} from '$lib/utils/comment-anchor';

/* ── Schema (write path is the only entry; zero DB CHECK) ───────────────── */

const codePointMax = (max: number) =>
	z.string().refine((value) => codePointLength(value) <= max, {
		message: `must be at most ${max} code points`
	});

const rangeSchema = z
	.object({
		start: z.number().int().min(0),
		end: z.number().int().min(0)
	})
	.refine(
		(range) =>
			range.end > range.start &&
			range.end - range.start >= ANCHOR_MIN_LENGTH &&
			range.end - range.start <= ANCHOR_MAX_LENGTH,
		{ message: `range must be [${ANCHOR_MIN_LENGTH}, ${ANCHOR_MAX_LENGTH}] code points` }
	);

/** Stored anchor shape (comments.anchor::jsonb, spec §4). */
export const commentAnchorSchema = z.object({
	v: z.literal(ANCHOR_VERSION),
	lang: z.string().min(2).max(16),
	block: z.object({
		hash: z.string().regex(new RegExp(`^[0-9a-f]{${ANCHOR_HASH_HEX_LENGTH}}$`)),
		occ: z.number().int().min(0),
		ord: z.number().int().min(0)
	}),
	range: rangeSchema,
	quote: z.object({
		exact: codePointMax(ANCHOR_MAX_LENGTH).refine((value) => value.length > 0),
		prefix: codePointMax(ANCHOR_PREFIX_MAX),
		suffix: codePointMax(ANCHOR_SUFFIX_MAX)
	})
});

/**
 * What the client actually submits. Prefix/suffix are deliberately absent:
 * the server derives them from its own block text (one ruler, no client
 * normalization dependency). `exact` is the staleness fingerprint.
 */
export const commentAnchorDraftSchema = z
	.object({
		ord: z.number().int().min(0),
		start: z.number().int().min(0),
		end: z.number().int().min(0),
		exact: codePointMax(ANCHOR_MAX_LENGTH).refine(
			(value) => codePointLength(value) >= ANCHOR_MIN_LENGTH,
			{ message: `exact must be at least ${ANCHOR_MIN_LENGTH} code points` }
		)
	})
	// Same [2, 500] window as the stored anchor: a draft the read schema would
	// reject must never reach the database (it would silently degrade to "no
	// anchor" on the next read).
	.refine(
		(draft) =>
			draft.end - draft.start >= ANCHOR_MIN_LENGTH && draft.end - draft.start <= ANCHOR_MAX_LENGTH,
		{ message: `range must be [${ANCHOR_MIN_LENGTH}, ${ANCHOR_MAX_LENGTH}] code points` }
	);

export function parseCommentAnchor(value: unknown): CommentAnchor | null {
	const parsed = commentAnchorSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function parseCommentAnchorDraft(value: unknown): CommentAnchorDraft | null {
	const parsed = commentAnchorDraftSchema.safeParse(value);
	if (!parsed.success) return null;
	const { ord, start, end, exact } = parsed.data;
	// The draft carries no context; the server derives prefix/suffix.
	return { ord, start, end, exact };
}

/* ── Block directory ────────────────────────────────────────────────────── */

/** One normalized code point of a block, mapped back to its text node. */
export interface AnchorTextPoint {
	node: Text;
	parent: Element;
	/** UTF-16 offset of this code point inside `node.value`. */
	offset: number;
	/** UTF-16 length of this code point (1, or 2 for a surrogate pair). */
	length: number;
}

export interface AnchorBlock {
	/** Anchorable-block ordinal in document order (empty blocks are not numbered). */
	ord: number;
	hash: string;
	occ: number;
	/** Normalized block text (spec §3). */
	text: string;
	/** One entry per normalized code point, in document order. */
	points: AnchorTextPoint[];
	element: Element;
}

export function hashBlockText(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, ANCHOR_HASH_HEX_LENGTH);
}

function shapeOf(element: Element): AnchorElementShape {
	const properties = element.properties ?? {};
	const className = Array.isArray(properties.className)
		? properties.className.map(String)
		: properties.className
			? [String(properties.className)]
			: [];
	return {
		tag: element.tagName,
		className,
		// hast stores data attributes camelCased (`dataRehypePrettyCodeFigure`);
		// the shared rule set names them the way HTML does. The DOM adapter just
		// calls `hasAttribute`, so both sides agree on the HTML spelling.
		hasAttr: (name) => {
			const camel = name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
			return Object.prototype.hasOwnProperty.call(properties, camel);
		}
	};
}

interface RawSegment {
	node: Text;
	parent: Element;
	value: string;
}

/**
 * Walk the tree in document order and return the block directory.
 *
 * Text belongs to its **nearest** block ancestor (spec §2): a block opens a
 * collector, nested blocks get their own, and skipped subtrees contribute
 * nothing. Blocks whose normalized text is empty (e.g. a `li` that only wraps
 * a `p`) are not numbered.
 */
export function collectAnchorBlocks(tree: HastRoot): AnchorBlock[] {
	const blocks: AnchorBlock[] = [];
	let current: RawSegment[] | null = null;
	let currentElement: Element | null = null;
	// Nested blocks close before their parent, so a plain push would emit
	// post-order. Each open block remembers where it started and splices itself
	// in there on close, which keeps `blocks` in document order.
	let currentInsert = 0;
	const stack: { segments: RawSegment[] | null; element: Element | null; insertIndex: number }[] =
		[];

	const openBlock = (element: Element) => {
		stack.push({ segments: current, element: currentElement, insertIndex: currentInsert });
		current = [];
		currentElement = element;
		currentInsert = blocks.length;
	};
	const closeBlock = () => {
		const segments = current ?? [];
		const element = currentElement;
		const insertIndex = currentInsert;
		const restored = stack.pop();
		current = restored?.segments ?? null;
		currentElement = restored?.element ?? null;
		currentInsert = restored?.insertIndex ?? 0;
		if (!element) return;
		const block = buildBlock(element, segments);
		if (block) blocks.splice(Math.min(insertIndex, blocks.length), 0, block);
	};

	const walk = (element: Element) => {
		const shape = shapeOf(element);
		if (isAnchorSkipped(shape)) return;
		// Structural wrapper rule (figure containing pre): attributes such as
		// `data-rehype-pretty-code-figure` do not survive every sanitize revision,
		// so the pretty-code wrapper is recognised by its shape instead.
		if (
			ANCHOR_SKIP_WRAPPERS.some(
				(wrapper) => wrapper.tag === element.tagName && hasDescendantTag(element, wrapper.contains)
			)
		) {
			return;
		}
		const isBlock = isAnchorBlock(shape);
		if (isBlock) openBlock(element);
		for (const child of element.children) {
			if (child.type === 'text') {
				if (current) current.push({ node: child, parent: element, value: child.value });
				continue;
			}
			if (child.type === 'element') walk(child);
		}
		if (isBlock) closeBlock();
	};

	for (const child of tree.children) {
		if (child.type === 'element') walk(child);
		else if (child.type === 'text' && current) {
			// Top-level text outside any block: not anchorable (blocks only).
		}
	}

	// Assign ord/occ after empty blocks are filtered, in document order.
	const seen = new Map<string, number>();
	let ord = 0;
	for (const block of blocks) {
		block.ord = ord;
		const occ = seen.get(block.hash) ?? 0;
		seen.set(block.hash, occ + 1);
		block.occ = occ;
		ord += 1;
	}
	return blocks;
}

function buildBlock(element: Element, segments: RawSegment[]): AnchorBlock | null {
	if (segments.length === 0) return null;
	// One folding implementation for both pipelines: the DOM walker feeds its own
	// node handles through the same `foldSegments` (spec §3).
	const folded = foldSegments(
		segments.map((segment) => ({
			value: segment.value,
			ref: { node: segment.node, parent: segment.parent }
		}))
	);
	if (folded.text.length === 0) return null;
	const points: AnchorTextPoint[] = folded.points.map((point) => ({
		node: point.ref.node,
		parent: point.ref.parent,
		offset: point.offset,
		length: point.length
	}));
	// `text` is code points joined; verify the invariant the walkers rely on.
	if (codePointLength(folded.text) !== points.length) {
		throw new Error('[comment-anchor] block text/point map diverged');
	}
	return {
		ord: -1,
		hash: hashBlockText(folded.text),
		occ: 0,
		text: folded.text,
		points,
		element
	};
}

/* ── Resolution ─────────────────────────────────────────────────────────── */

export interface ResolvedAnchor {
	block: AnchorBlock;
	start: number;
	end: number;
}

function sliceOf(block: AnchorBlock, start: number, end: number): string {
	return codePointSlice(block.text, start, end);
}

function inRange(block: AnchorBlock, start: number, end: number): boolean {
	return start >= 0 && end <= codePointLength(block.text) && end > start;
}

/**
 * Read-side resolution (spec §7): L0 range check on the stored ord, L1 exact
 * search inside the block(s) with the stored hash, L2 a ±2 block window around
 * ord with prefix/suffix matching, then miss (the caller renders it in the
 * folded "original text changed" area).
 *
 * The hash is a fast path, not an authority: a typo fix elsewhere in the block
 * keeps the quote valid, which is exactly what the quote selectors are for
 * (W3C: positions are "very brittle", quote selectors are the fallback).
 */
export function resolveAnchor(blocks: AnchorBlock[], anchor: CommentAnchor): ResolvedAnchor | null {
	const byOrd = blocks.find((block) => block.ord === anchor.block.ord);
	if (
		byOrd &&
		inRange(byOrd, anchor.range.start, anchor.range.end) &&
		sliceOf(byOrd, anchor.range.start, anchor.range.end) === anchor.quote.exact &&
		// The range alone is not enough: the same sentence can occur twice in one
		// block, and a stale range would then point at the wrong occurrence.
		contextMatches(
			byOrd,
			anchor.range.start,
			anchor.range.end,
			anchor.quote.prefix,
			anchor.quote.suffix
		)
	) {
		return { block: byOrd, start: anchor.range.start, end: anchor.range.end };
	}

	// L1: same content hash somewhere in the document, nearest ord first.
	const sameHash = blocks
		.filter((block) => block.hash === anchor.block.hash)
		.sort((a, b) => Math.abs(a.ord - anchor.block.ord) - Math.abs(b.ord - anchor.block.ord));
	for (const block of sameHash) {
		const found = searchExact(block, anchor.quote.exact, anchor.quote.prefix, anchor.quote.suffix);
		if (found) return found;
	}

	// L2: neighbours of the stored ord (insert/remove of other blocks shifted it).
	const window = blocks
		.filter((block) => Math.abs(block.ord - anchor.block.ord) <= 2)
		.sort((a, b) => Math.abs(a.ord - anchor.block.ord) - Math.abs(b.ord - anchor.block.ord));
	for (const block of window) {
		const found = searchExact(block, anchor.quote.exact, anchor.quote.prefix, anchor.quote.suffix);
		if (found) return found;
	}
	return null;
}

/** Prefix/suffix around a candidate range, compared in code points. */
function contextMatches(
	block: AnchorBlock,
	start: number,
	end: number,
	prefix: string,
	suffix: string
): boolean {
	const codePoints = Array.from(block.text);
	const prefixLength = codePointLength(prefix);
	const suffixLength = codePointLength(suffix);
	const before = codePoints.slice(Math.max(0, start - prefixLength), start).join('');
	const after = codePoints.slice(end, end + suffixLength).join('');
	const prefixOk = prefix.length === 0 || before.endsWith(prefix);
	const suffixOk = suffix.length === 0 || after.startsWith(suffix);
	return prefixOk && suffixOk;
}

/** Locate `exact` inside one block; context disambiguates repeated text. */
function searchExact(
	block: AnchorBlock,
	exact: string,
	prefix: string,
	suffix: string
): ResolvedAnchor | null {
	const codePoints = Array.from(block.text);
	const prefixLength = codePointLength(prefix);
	const suffixLength = codePointLength(suffix);
	let from = 0;
	while (true) {
		const at = block.text.indexOf(exact, from);
		if (at < 0) return null;
		const start = utf16ToCodePoint(block.text, at);
		const end = start + codePointLength(exact);
		const before = codePoints.slice(Math.max(0, start - prefixLength), start).join('');
		const after = codePoints.slice(end, end + suffixLength).join('');
		const prefixOk = prefix.length === 0 || before.endsWith(prefix);
		const suffixOk = suffix.length === 0 || after.startsWith(suffix);
		if (prefixOk && suffixOk) return { block, start, end };
		from = at + Math.max(1, exact.length);
	}
}

/**
 * Write-side resolution (spec §6): the client sends ord + range + exact.
 * Order: exact block at ord -> quote search inside that block -> the ±2
 * neighbour window. Anything else is stale (400). No merging: the same range
 * simply becomes another root.
 */
export function resolveAnchorDraft(
	blocks: AnchorBlock[],
	draft: CommentAnchorDraft,
	lang: string
): { kind: 'ok'; anchor: CommentAnchor } | { kind: 'stale' } {
	// Endpoints must be grapheme-cluster boundaries (spec §3): a selection that
	// splits an emoji/ZWJ cluster is rejected rather than stored as a broken span.
	const accept = (
		block: AnchorBlock,
		start: number,
		end: number
	): { kind: 'ok'; anchor: CommentAnchor } | { kind: 'stale' } =>
		isGraphemeBoundary(block.text, start) && isGraphemeBoundary(block.text, end)
			? { kind: 'ok', anchor: buildAnchor(block, start, end, lang) }
			: { kind: 'stale' };

	const ordBlock = blocks.find((block) => block.ord === draft.ord);
	if (ordBlock) {
		if (
			inRange(ordBlock, draft.start, draft.end) &&
			sliceOf(ordBlock, draft.start, draft.end) === draft.exact
		) {
			return accept(ordBlock, draft.start, draft.end);
		}
		// The quote moved inside the same block (text before the selection changed).
		const found = searchExact(ordBlock, draft.exact, '', '');
		if (found) return accept(found.block, found.start, found.end);
	}
	const window = blocks
		.filter((block) => Math.abs(block.ord - draft.ord) <= 2)
		.sort((a, b) => Math.abs(a.ord - draft.ord) - Math.abs(b.ord - draft.ord));
	for (const block of window) {
		const found = searchExact(block, draft.exact, '', '');
		if (found) return accept(found.block, found.start, found.end);
	}
	return { kind: 'stale' };
}

function hasDescendantTag(element: Element, tag: string): boolean {
	for (const child of element.children) {
		if (child.type !== 'element') continue;
		if (child.tagName === tag) return true;
		if (hasDescendantTag(child, tag)) return true;
	}
	return false;
}

interface GraphemeSegmenter {
	segment(input: string): Iterable<{ index: number }>;
}

/**
 * True when `offset` (in code points) sits on a grapheme-cluster boundary.
 * Splitting a surrogate pair is always rejected; when Intl.Segmenter is not
 * available the check degrades to that surrogate guard (registered deviation).
 */
function isGraphemeBoundary(text: string, offset: number): boolean {
	const total = codePointLength(text);
	if (offset <= 0 || offset >= total) return true;
	const utf16 = codePointToUtf16(text, offset);
	if (splitsSurrogatePair(text, utf16)) return false;
	const SegmenterCtor = (
		Intl as unknown as {
			Segmenter?: new (
				locales?: string,
				options?: { granularity: 'grapheme' }
			) => GraphemeSegmenter;
		}
	).Segmenter;
	if (!SegmenterCtor) return true;
	const segmenter = new SegmenterCtor(undefined, { granularity: 'grapheme' });
	for (const part of segmenter.segment(text)) {
		if (part.index === utf16) return true;
		if (part.index > utf16) return false;
	}
	return true;
}

/** Derive the stored anchor (prefix/suffix come from the server's own text). */
function buildAnchor(block: AnchorBlock, start: number, end: number, lang: string): CommentAnchor {
	const codePoints = Array.from(block.text);
	const quote = {
		exact: codePoints.slice(start, end).join(''),
		prefix: codePoints.slice(Math.max(0, start - ANCHOR_PREFIX_MAX), start).join(''),
		suffix: codePoints.slice(end, end + ANCHOR_SUFFIX_MAX).join('')
	};
	const blockRef: AnchorBlockRef = { hash: block.hash, occ: block.occ, ord: block.ord };
	return { v: ANCHOR_VERSION, lang, block: blockRef, range: { start, end }, quote };
}

/* ── Marking ────────────────────────────────────────────────────────────── */

export interface AnchorMark {
	commentId: string;
	blockOrd: number;
	start: number;
	end: number;
	/** The viewer's own pending comment -> dashed underline. */
	pending: boolean;
}

/**
 * Wrap resolved ranges in `span.wl-cm` (spec §7). Ranges are stated in the
 * *original* block coordinates, so all marks are applied in one pass per text
 * node — never sequentially — otherwise a split would invalidate the next
 * mark's node reference.
 *
 * Per text node: intersect every mark, cut at the union of boundaries, and
 * emit nested spans ordered outermost-first (earlier start, longer range).
 * A range crossing inline elements yields one span per element; `id` (deep
 * link target) is placed on the first span of the range only. Identical
 * ranges collapse into a single span carrying every id (`data-cids`), so
 * repeated comments on one sentence cannot build 200 nested spans.
 */
export function applyAnchorMarks(
	blocks: AnchorBlock[],
	marks: AnchorMark[]
): Map<string, string | null> {
	// commentId -> the anchor id actually placed (null when nothing was emitted).
	const placed = new Map<string, string | null>();
	const byBlock = new Map<number, AnchorMark[]>();
	for (const mark of marks) {
		placed.set(mark.commentId, null);
		const list = byBlock.get(mark.blockOrd);
		if (list) list.push(mark);
		else byBlock.set(mark.blockOrd, [mark]);
	}

	for (const block of blocks) {
		const blockMarks = byBlock.get(block.ord);
		if (!blockMarks || blockMarks.length === 0) continue;

		// Group identical ranges (same start/end) into one cluster.
		type Cluster = { start: number; end: number; ids: string[]; pending: boolean };
		const clusters: Cluster[] = [];
		for (const mark of blockMarks) {
			const existing = clusters.find((c) => c.start === mark.start && c.end === mark.end);
			if (existing) {
				existing.ids.push(mark.commentId);
				existing.pending = existing.pending && mark.pending;
			} else {
				clusters.push({
					start: mark.start,
					end: mark.end,
					ids: [mark.commentId],
					pending: mark.pending
				});
			}
		}
		// Stable nesting: earlier start first, longer range first.
		clusters.sort((a, b) => a.start - b.start || b.end - a.end);

		// Per text node, gather (start,end,cluster) intersections in raw UTF-16.
		interface Hit {
			from: number;
			to: number;
			cluster: Cluster;
			/** The text node's parent, recorded during collection (no re-walk). */
			parent: Element;
		}
		const hitsByNode = new Map<Text, Hit[]>();
		for (const cluster of clusters) {
			for (let index = cluster.start; index < cluster.end; index += 1) {
				const point = block.points[index];
				if (!point) continue;
				let hits = hitsByNode.get(point.node);
				if (!hits) {
					hits = [];
					hitsByNode.set(point.node, hits);
				}
				const existing = hits.find((hit) => hit.cluster === cluster);
				if (existing) existing.to = point.offset + point.length;
				else
					hits.push({
						from: point.offset,
						to: point.offset + point.length,
						cluster,
						parent: point.parent
					});
			}
		}

		const idPlaced = new Set<Cluster>();
		for (const [node, hits] of hitsByNode) {
			const parent = hits[0].parent;
			const index = parent.children.indexOf(node as ElementContent);
			if (index < 0) continue;
			const boundaries = new Set<number>([0, node.value.length]);
			for (const hit of hits) {
				boundaries.add(hit.from);
				boundaries.add(hit.to);
			}
			const sorted = [...boundaries].sort((a, b) => a - b);
			const replacement: ElementContent[] = [];
			for (let i = 0; i < sorted.length - 1; i += 1) {
				const from = sorted[i];
				const to = sorted[i + 1];
				if (to <= from) continue;
				const active = hits
					.filter((hit) => hit.from <= from && hit.to >= to)
					.sort((a, b) => a.cluster.start - b.cluster.start || b.cluster.end - a.cluster.end);
				let content: ElementContent = { type: 'text', value: node.value.slice(from, to) };
				for (let depth = active.length - 1; depth >= 0; depth -= 1) {
					const { cluster } = active[depth];
					const properties: Element['properties'] = {
						className: cluster.pending ? ['wl-cm', 'wl-cm-pending'] : ['wl-cm'],
						dataCid: cluster.ids[0],
						dataCids: cluster.ids.join(' ')
					};
					if (!idPlaced.has(cluster)) {
						properties.id = `c-${cluster.ids[0]}`;
						idPlaced.add(cluster);
						for (const id of cluster.ids) placed.set(id, `c-${cluster.ids[0]}`);
					}
					content = {
						type: 'element',
						tagName: 'span',
						properties,
						children: [content]
					};
				}
				replacement.push(content);
			}
			parent.children.splice(index, 1, ...replacement);
		}
	}
	return placed;
}
