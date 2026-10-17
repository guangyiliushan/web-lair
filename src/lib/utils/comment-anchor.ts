/**
 * Segment-comment anchor contract v1 (comment P3b; spec v0.1.3 §2–§4, ledger
 * §27). Deliberately isomorphic and **zod-free**: the client (selection
 * capture) and the server (hast walker / validation / marking) must share one
 * set of rules, and that rules module must not drag the validator into the
 * browser bundle. The zod schema + the hash live in
 * `$lib/server/comment-anchor.ts`.
 *
 * Coordinate contract (2026-10-17 grill, M5): every offset is a **Unicode
 * code point** index into the block's normalized text — never a UTF-16 code
 * unit index (W3C Web Annotation Model §4.2.4: "MUST be in terms of unicode
 * code points … not in terms of code units"). The same module therefore owns
 * the code-point/UTF-16 bridge the server marking pass needs.
 */

/** Anchor payload version. A rule change means a new version (old anchors degrade). */
export const ANCHOR_VERSION = 1;

/** Selected span bounds, in code points (spec §4). */
export const ANCHOR_MIN_LENGTH = 2;
export const ANCHOR_MAX_LENGTH = 500;

/** Context snippets, in code points (spec §4; reference impl uses 32, we keep 24). */
export const ANCHOR_PREFIX_MAX = 24;
export const ANCHOR_SUFFIX_MAX = 24;

/** Block fingerprint: sha256 of the normalized block text, first 10 hex chars. */
export const ANCHOR_HASH_HEX_LENGTH = 10;

/** Display cap for a quote chip / queue excerpt, in code points. */
export const ANCHOR_QUOTE_DISPLAY_MAX = 120;

export interface AnchorBlockRef {
	/** sha256(normalized block text) sliced to ANCHOR_HASH_HEX_LENGTH. */
	hash: string;
	/**
	 * Occurrence index among blocks with the same hash, in document order.
	 * Diagnostic today: the resolver ranks same-hash candidates by `|ord -
	 * stored.ord|`, which is the same order, so `occ` is not consulted. Kept in
	 * the v1 contract as the disambiguator if a large ord shift ever misranks
	 * duplicate blocks (see ledger §27 registers).
	 */
	occ: number;
	/** Anchorable-block ordinal; a diagnostic / search-window hint, never authority. */
	ord: number;
}

export interface AnchorRange {
	/** Inclusive start, code points into the normalized block text. */
	start: number;
	/** Exclusive end, code points into the normalized block text. */
	end: number;
}

export interface AnchorQuote {
	/** The selected text, after normalization (W3C TextQuoteSelector#exact). */
	exact: string;
	/** Up to ANCHOR_PREFIX_MAX code points immediately before the range. */
	prefix: string;
	/** Up to ANCHOR_SUFFIX_MAX code points immediately after the range. */
	suffix: string;
}

export interface CommentAnchor {
	v: typeof ANCHOR_VERSION;
	/** Body language this anchor was written against (posts/notes are per-language rows). */
	lang: string;
	block: AnchorBlockRef;
	range: AnchorRange;
	quote: AnchorQuote;
}

/**
 * What the client submits: the ordinal it resolved the selection against plus
 * the range and quote. Hash/occurrence are recomputed server-side, so a stale
 * or forged client payload can never define them.
 */
export interface CommentAnchorDraft {
	ord: number;
	start: number;
	end: number;
	exact: string;
	/**
	 * Code points of the block the reader selected. Optional because older
	 * clients omit it; when present the server refuses to trust `ord` against a
	 * block of a different length (stale-ord fingerprint, spec §5 M11).
	 */
	blockLength?: number;
}

/* ── Block model (single source for both walkers) ───────────────────────── */

/** Leaf text blocks that may carry a segment anchor (spec §2). */
export const ANCHOR_BLOCK_TAGS: ReadonlySet<string> = new Set([
	'p',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'li',
	'td',
	'th',
	'figcaption'
]);

/**
 * Subtrees whose text never belongs to the selectable document text: rendered
 * derivatives (KaTeX / mermaid), code blocks, embed placeholders, the heading
 * anchor link, layout containers (grid/tabs/details) and the footnote area.
 * Inline `<code>` is deliberately NOT here: W3C normalizes by removing tags
 * and keeping their content, and dropping inline code would break quotes such
 * as "call `foo()` now".
 */
export const ANCHOR_SKIP_TAGS: ReadonlySet<string> = new Set([
	'pre',
	'hr',
	'img',
	'input',
	'details'
]);

export const ANCHOR_SKIP_CLASSES: ReadonlySet<string> = new Set([
	'katex',
	'mermaid',
	'embed-card',
	'md-anchor',
	'md-tabs',
	'md-tab',
	'md-grid',
	'md-details'
]);

/** Attribute markers that exclude a subtree (pipeline output only). */
export const ANCHOR_SKIP_ATTRS: ReadonlySet<string> = new Set([
	'data-rehype-pretty-code-figure',
	'data-footnotes',
	'data-footnote-ref'
]);

/**
 * Minimal element shape shared by hast and DOM nodes. Both walkers adapt their
 * native node to this shape, so the skip/block predicates below are the one
 * place the two pipelines can drift — and they cannot, by construction.
 */
export interface AnchorElementShape {
	tag: string;
	className: readonly string[];
	hasAttr: (name: string) => boolean;
}

/**
 * Wrapper subtrees that are skipped when they contain a descendant tag.
 * The pretty-code figure is matched structurally (`figure` containing `pre`),
 * not by `data-rehype-pretty-code-figure`: the sanitizer's attribute whitelist
 * does not survive every pipeline revision, and a structural rule cannot drift.
 */
export const ANCHOR_SKIP_WRAPPERS: ReadonlyArray<{ tag: string; contains: string }> = [
	{ tag: 'figure', contains: 'pre' }
];

export function isAnchorSkipped(el: AnchorElementShape): boolean {
	if (ANCHOR_SKIP_TAGS.has(el.tag)) return true;
	for (const cls of el.className) if (ANCHOR_SKIP_CLASSES.has(cls)) return true;
	for (const attr of ANCHOR_SKIP_ATTRS) if (el.hasAttr(attr)) return true;
	return false;
}

/** A block is an anchorable leaf text block (skip rules win over the tag set). */
export function isAnchorBlock(el: AnchorElementShape): boolean {
	return ANCHOR_BLOCK_TAGS.has(el.tag) && !isAnchorSkipped(el);
}

/* ── Text normalization ─────────────────────────────────────────────────── */

/* ── Shared folding (both pipelines map their own nodes through this) ───── */

export interface FoldSegment<T> {
	/** Raw text of one text node (or run), in document order. */
	value: string;
	/** Owner-specific handle (hast Text+parent, DOM Text+parent, ...). */
	ref: T;
}

export interface FoldPoint<T> {
	ref: T;
	/** UTF-16 offset of this code point inside the segment's raw text. */
	offset: number;
	/** UTF-16 length of this code point (1, or 2 for a surrogate pair). */
	length: number;
}

/**
 * Fold a block's raw segments into its normalized text (spec §3) while keeping
 * a code-point -> raw-offset map. This is the one place the two pipelines can
 * disagree if reimplemented, so both call it with their own node handle.
 *
 * Concatenate first, then fold globally: collapsing per segment would turn
 * `"a " + inline-math(void) + " b"` into `"a  b"` (measured in the 2026-10-17
 * grill). Leading/trailing runs disappear; void runs contribute nothing.
 */
export function foldSegments<T>(segments: readonly FoldSegment<T>[]): {
	text: string;
	points: FoldPoint<T>[];
} {
	let text = '';
	const points: FoldPoint<T>[] = [];
	let pendingSpace: FoldPoint<T> | null = null;
	for (const segment of segments) {
		let offset = 0;
		for (const ch of segment.value) {
			const length = ch.length;
			if (/\s/.test(ch)) {
				if (text.length > 0 && pendingSpace === null) {
					pendingSpace = { ref: segment.ref, offset, length };
				}
			} else {
				if (pendingSpace) {
					text += ' ';
					points.push(pendingSpace);
					pendingSpace = null;
				}
				text += ch;
				points.push({ ref: segment.ref, offset, length });
			}
			offset += length;
		}
	}
	return { text, points };
}

/* ── Code point helpers ─────────────────────────────────────────────────── */

/** Length in Unicode code points (never UTF-16 units). */
export function codePointLength(value: string): number {
	return [...value].length;
}

/** [start, end) slice by code point index; UTF-16 indices never leak out. */
export function codePointSlice(value: string, start: number, end: number): string {
	return Array.from(value).slice(start, end).join('');
}

/** UTF-16 offset -> code point offset. */
export function utf16ToCodePoint(value: string, utf16Offset: number): number {
	let codePoints = 0;
	for (let i = 0; i < utf16Offset && i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		const isPair = code >= 0xd800 && code <= 0xdbff && i + 1 < value.length;
		if (isPair) i += 1;
		codePoints += 1;
	}
	return codePoints;
}

/** Code point offset -> UTF-16 offset. */
export function codePointToUtf16(value: string, codePointOffset: number): number {
	let codePoints = 0;
	let i = 0;
	while (i < value.length && codePoints < codePointOffset) {
		const code = value.charCodeAt(i);
		const isPair = code >= 0xd800 && code <= 0xdbff && i + 1 < value.length;
		i += isPair ? 2 : 1;
		codePoints += 1;
	}
	return i;
}

/**
 * True when a UTF-16 offset splits a surrogate pair (i.e. it is not a valid
 * code point boundary). Selections ending there are rejected (spec §3).
 */
export function splitsSurrogatePair(value: string, utf16Offset: number): boolean {
	if (utf16Offset <= 0 || utf16Offset >= value.length) return false;
	const before = value.charCodeAt(utf16Offset - 1);
	const after = value.charCodeAt(utf16Offset);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Quote chip / queue excerpt: cap in code points (ellipsis included), never 121. */

interface GraphemeSegmenter {
	segment(input: string): Iterable<{ index: number }>;
}

/**
 * True when `offset` (in code points) sits on a grapheme-cluster boundary.
 * Splitting a surrogate pair is always rejected; when Intl.Segmenter is not
 * available the check degrades to that surrogate guard (registered deviation).
 *
 * Shared by both pipelines: the writer rejects a selection that cuts a cluster
 * at submit time, and the DOM layer refuses to offer the action for one.
 */
export function isGraphemeBoundary(text: string, offset: number): boolean {
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

export function quoteDisplay(exact: string, max = ANCHOR_QUOTE_DISPLAY_MAX): string {
	const chars = Array.from(exact);
	if (chars.length <= max) return exact;
	return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}
