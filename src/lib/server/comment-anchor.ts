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
	blockFingerprint,
	codePointLength,
	codePointSlice,
	foldSegments,
	isAnchorBlock,
	isAnchorSkipped,
	isGraphemeBoundary,
	splitsSurrogatePair,
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
export const commentAnchorSchema = z
	.object({
		v: z.literal(ANCHOR_VERSION),
		lang: z.string().min(2).max(16),
		block: z.object({
			hash: z.string().regex(new RegExp(`^[0-9a-f]{${ANCHOR_HASH_HEX_LENGTH}}$`)),
			occ: z.number().int().min(0),
			ord: z.number().int().min(0)
		}),
		range: rangeSchema,
		quote: z.object({
			exact: codePointMax(ANCHOR_MAX_LENGTH).refine(
				(value) => codePointLength(value) >= ANCHOR_MIN_LENGTH,
				{ message: `exact must be at least ${ANCHOR_MIN_LENGTH} code points` }
			),
			prefix: codePointMax(ANCHOR_PREFIX_MAX),
			suffix: codePointMax(ANCHOR_SUFFIX_MAX)
		})
	})
	.superRefine((anchor, ctx) => {
		// A stored row whose quote and range disagree would make the resolver search
		// an arbitrary string; every app write satisfies this, so the check costs
		// nothing and catches corrupted/manual rows at the boundary.
		if (codePointLength(anchor.quote.exact) !== anchor.range.end - anchor.range.start) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['quote', 'exact'],
				message: 'quote length must equal the stored range'
			});
		}
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
		),
		/** Code points of the block the reader selected (stale-ord fingerprint). */
		blockLength: z.number().int().min(0).optional(),
		/** FNV-1a of the block text; rejects same-length lookalikes at a shifted ord. */
		blockFingerprint: z
			.string()
			.regex(/^[0-9a-f]{8}$/)
			.optional()
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
	// Return the parsed data as-is: hand-projecting the four original keys once
	// dropped `blockLength`, which made the stale-ord fingerprint dead code over
	// HTTP while its unit tests (calling the resolver directly) stayed green.
	return parsed.success ? parsed.data : null;
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
	/** Child -> parent within the walked tree (link detection for marks). */
	parents?: WeakMap<Element, Element>;
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
	const parents = new WeakMap<Element, Element>();
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
			if (child.type === 'element') {
				parents.set(child, element);
				walk(child);
			}
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
		block.parents = parents;
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
 * Read-side resolution (spec §7), in order:
 *
 * 1. blocks that still carry the stored content hash (identity outranks
 *    position: an inserted paragraph at the old ordinal must not steal the
 *    comment just because it happens to contain the same short quote),
 * 2. the block at the stored ordinal,
 * 3. the ±2 neighbour window (blocks that moved after an insert/delete).
 *
 * Inside a block the quote decides. Context (prefix/suffix) is required only
 * when identity is unknown; a quote that occurs in exactly one block may be
 * accepted without context, which is what keeps a typo elsewhere in the block
 * from orphaning an intact anchor.
 */
export function resolveAnchor(blocks: AnchorBlock[], anchor: CommentAnchor): ResolvedAnchor | null {
	const quote = anchor.quote;
	const hint = anchor.range.start;
	const distance = (block: AnchorBlock) => Math.abs(block.ord - anchor.block.ord);
	const byDistance = (a: AnchorBlock, b: AnchorBlock) => distance(a) - distance(b);

	const stored = blocks.find((block) => block.ord === anchor.block.ord) ?? null;
	const quoteBlocks = blocks.filter((block) => block.text.includes(quote.exact));
	// A context-less match is only trustworthy when the quote pins exactly one
	// block; otherwise it is the inserted-paragraph trap.
	const globallyUniqueQuote = quoteBlocks.length === 1;

	const candidates: AnchorBlock[] = [];
	const seen = new Set<AnchorBlock>();
	const push = (block: AnchorBlock) => {
		if (seen.has(block)) return;
		seen.add(block);
		candidates.push(block);
	};
	blocks
		.filter((block) => block.hash === anchor.block.hash)
		.sort(byDistance)
		.forEach(push);
	if (stored) push(stored);
	blocks
		.filter((block) => distance(block) <= 2)
		.sort(byDistance)
		.forEach(push);

	for (const block of candidates) {
		const picked = pickOccurrence(block, quote, hint);
		if (!picked) continue;
		if (!isGraphemeBoundary(block.text, picked.start)) continue;
		if (!isGraphemeBoundary(block.text, picked.end)) continue;
		const identityKnown = block.hash === anchor.block.hash;
		const contextOk = contextMatches(block, picked.start, picked.end, quote.prefix, quote.suffix);
		if (identityKnown || contextOk || globallyUniqueQuote) {
			return { block, start: picked.start, end: picked.end };
		}
	}
	return null;
}

interface Occurrence {
	start: number;
	end: number;
}

/** Guard against a two-code-point quote repeated across a huge paragraph. */
const MAX_OCCURRENCES = 200;

const codePointCache = new WeakMap<AnchorBlock, string[]>();
function codePointsOf(block: AnchorBlock): string[] {
	let cached = codePointCache.get(block);
	if (!cached) {
		cached = Array.from(block.text);
		codePointCache.set(block, cached);
	}
	return cached;
}

/**
 * Every occurrence of `exact`, as code point ranges. Overlapping matches are
 * enumerated too (`"aba"` in `"ababa"` occurs at 0 and 2): stopping at the end
 * of each match hid valid stored occurrences and made unchanged text resolve to
 * the wrong span or orphan. The scan advances one code point at a time and
 * keeps a running code-point counter, so the whole enumeration is linear.
 */
function occurrencesOf(
	block: AnchorBlock,
	exact: string
): { found: Occurrence[]; truncated: boolean } {
	if (exact.length === 0) return { found: [], truncated: false };
	const text = block.text;
	const exactLength = codePointLength(exact);
	const found: Occurrence[] = [];
	let from = 0;
	let scanUtf16 = 0;
	let scanCodePoint = 0;
	while (found.length < MAX_OCCURRENCES) {
		const at = text.indexOf(exact, from);
		if (at < 0) break;
		if (splitsSurrogatePair(text, at)) {
			from = at + 1;
			continue;
		}
		while (scanUtf16 < at) {
			const value = text.codePointAt(scanUtf16) ?? 0;
			scanUtf16 += value > 0xffff ? 2 : 1;
			scanCodePoint += 1;
		}
		found.push({ start: scanCodePoint, end: scanCodePoint + exactLength });
		from = at + 1;
	}
	// Whether a further occurrence exists decides between "ambiguous" and
	// "complete": a truncated scan must never pick a neighbour silently.
	const truncated = found.length >= MAX_OCCURRENCES && text.indexOf(exact, from) >= 0;
	return { found, truncated };
}

/** Prefix/suffix around a candidate range, compared in code points. */
function contextMatches(
	block: AnchorBlock,
	start: number,
	end: number,
	prefix: string,
	suffix: string
): boolean {
	const codePoints = codePointsOf(block);
	const prefixLength = codePointLength(prefix);
	const suffixLength = codePointLength(suffix);
	const before = codePoints.slice(Math.max(0, start - prefixLength), start).join('');
	const after = codePoints.slice(end, end + suffixLength).join('');
	const prefixOk = prefix.length === 0 || before.endsWith(prefix);
	const suffixOk = suffix.length === 0 || after.startsWith(suffix);
	return prefixOk && suffixOk;
}

/**
 * Which occurrence of the quote this block means. `hint` is the stored start
 * offset: it is only consulted when the text alone is ambiguous.
 */
function pickOccurrence(
	block: AnchorBlock,
	quote: CommentAnchor['quote'],
	hint: number
): Occurrence | null {
	const { found: occurrences, truncated } = occurrencesOf(block, quote.exact);
	if (occurrences.length === 0) return null;
	// Past the cap the text alone is ambiguous: only the stored offset can
	// decide, and if it is not among the enumerated runs the block misses
	// instead of resolving to a lookalike.
	if (truncated) {
		return occurrences.find((occurrence) => occurrence.start === hint) ?? null;
	}
	if (occurrences.length === 1) return occurrences[0];

	const contextual = occurrences.filter((occurrence) =>
		contextMatches(block, occurrence.start, occurrence.end, quote.prefix, quote.suffix)
	);
	if (contextual.length === 1) return contextual[0];
	if (contextual.length > 1) {
		// The stored offset is the only thing that distinguishes identical runs;
		// prefer it over pure distance when it survived.
		return contextual.find((occurrence) => occurrence.start === hint) ?? nearest(contextual, hint);
	}

	// No context survived (the surrounding text was edited): trust the stored
	// range only if it is itself an occurrence; otherwise this is ambiguous.
	return occurrences.find((occurrence) => occurrence.start === hint) ?? null;
}

function nearest(occurrences: Occurrence[], hint: number): Occurrence {
	return occurrences.reduce((best, current) =>
		Math.abs(current.start - hint) < Math.abs(best.start - hint) ? current : best
	);
}

/**
 * Write-side resolution (spec §6): the client sends ord + range + exact.
 * defined. Order: exact block at ord (gated by the block-length/fingerprint
 * hint) -> quote search inside that block -> the ±2 neighbour window. Anything
 * else is stale (400). No merging: the same range becomes another root.
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
	// The ordinal alone is only trusted when the block is the one the reader
	// saw: an insertion above shifts ordinals, and a repeated quote in the
	// shifted block would otherwise bind to the wrong passage. Length is a
	// cheap fingerprint, not a hash (spec §5 M11).
	const fingerprintMatches = (block: AnchorBlock) =>
		draft.blockFingerprint === undefined || blockFingerprint(block.text) === draft.blockFingerprint;
	// Length alone cannot separate uniform list rows (same length, same quote);
	// the content fingerprint is what makes a shifted ordinal detectable.
	const ordBlockIsStale =
		!!ordBlock &&
		((draft.blockLength !== undefined && codePointLength(ordBlock.text) !== draft.blockLength) ||
			!fingerprintMatches(ordBlock));
	if (ordBlock && !ordBlockIsStale) {
		if (
			inRange(ordBlock, draft.start, draft.end) &&
			sliceOf(ordBlock, draft.start, draft.end) === draft.exact
		) {
			return accept(ordBlock, draft.start, draft.end);
		}
		// The quote moved inside the same block (text before the selection changed).
		const found = pickOccurrence(
			ordBlock,
			{ exact: draft.exact, prefix: '', suffix: '' },
			draft.start
		);
		if (found) return accept(ordBlock, found.start, found.end);
	}
	// With a fingerprint, only blocks of the length the reader actually saw are
	// candidates. No candidate means the article changed under the selection:
	// stale beats binding the quote to a lookalike block.
	const window = blocks
		.filter((block) => Math.abs(block.ord - draft.ord) <= 2)
		.filter(
			(block) =>
				(draft.blockLength === undefined || codePointLength(block.text) === draft.blockLength) &&
				(draft.blockFingerprint === undefined ||
					blockFingerprint(block.text) === draft.blockFingerprint)
		)
		.sort((a, b) => Math.abs(a.ord - draft.ord) - Math.abs(b.ord - draft.ord));
	// Without client context a window hit is only safe when the quote is unique
	// across the document: two candidate paragraphs mean the page moved under
	// the reader, and guessing would store a permanently wrong anchor.
	const quoteBlocks = blocks.filter((block) => block.text.includes(draft.exact)).length;
	for (const block of window) {
		const found = pickOccurrence(
			block,
			{ exact: draft.exact, prefix: '', suffix: '' },
			draft.start
		);
		if (!found) continue;
		// A verified fingerprint resolves the ambiguity; without one, guessing a
		// neighbouring block would store a permanently wrong anchor.
		if (quoteBlocks > 1 && block.ord !== draft.ord && draft.blockFingerprint === undefined) {
			return { kind: 'stale' };
		}
		return accept(block, found.start, found.end);
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
function insideLink(start: Element, block: AnchorBlock): boolean {
	let current: Element | undefined = start;
	while (current && current !== block.element) {
		if (current.tagName.toLowerCase() === 'a') return true;
		current = block.parents?.get(current);
	}
	return false;
}

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
				// Marks inside a link must stay presentation-only: an interactive
				// span nested in <a> is invalid content, and the click belongs to
				// the link (the thread stays reachable from the list).
				const linkHosted = insideLink(parent, block);
				for (let depth = active.length - 1; depth >= 0; depth -= 1) {
					const { cluster } = active[depth];
					const properties: Element['properties'] = {
						className: cluster.pending ? ['wl-cm', 'wl-cm-pending'] : ['wl-cm'],
						dataCid: cluster.ids[0],
						dataCids: cluster.ids.join(' ')
					};
					if (!idPlaced.has(cluster)) {
						properties.id = `c-${cluster.ids[0]}`;
						// The first span of a cluster is the keyboard entry point:
						// marks were mouse-only before (WCAG 2.1.1). Link-hosted
						// marks stay out of the tab order (see above).
						if (!linkHosted) {
							properties.tabIndex = 0;
							properties.role = 'button';
							properties.ariaHaspopup = 'dialog';
						}
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
