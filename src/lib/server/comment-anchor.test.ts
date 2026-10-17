import { describe, expect, it } from 'vitest';
import type { Element, ElementContent, Root as HastRoot, Text } from 'hast';
import {
	applyAnchorMarks,
	collectAnchorBlocks,
	commentAnchorSchema,
	hashBlockText,
	parseCommentAnchor,
	parseCommentAnchorDraft,
	resolveAnchor,
	resolveAnchorDraft,
	type AnchorBlock,
	type AnchorMark
} from './comment-anchor';

/* ── hast fixture helpers ───────────────────────────────────────────────── */

const text = (value: string): Text => ({ type: 'text', value });

const el = (
	tagName: string,
	children: ElementContent[],
	properties: Element['properties'] = {}
): Element => ({
	type: 'element',
	tagName,
	properties,
	children
});

const span = (className: string[], children: ElementContent[]) =>
	el('span', children, { className });

const p = (...children: ElementContent[]) => el('p', children);
const root = (...children: ElementContent[]): HastRoot => ({ type: 'root', children });

function plain(node: Element | Text | HastRoot): string {
	if (node.type === 'text') return node.value;
	if (node.type === 'element' || node.type === 'root') {
		return (node.children as Array<Element | Text>).map((child) => plain(child)).join('');
	}
	return '';
}

function blockTexts(blocks: AnchorBlock[]): string[] {
	return blocks.map((block) => block.text);
}

/* ── Block directory ────────────────────────────────────────────────────── */

describe('collectAnchorBlocks (spec §2/§3)', () => {
	it('walks leaf blocks in document order and skips void subtrees', () => {
		const tree = root(
			el('h2', [el('a', [text('·')], { className: ['md-anchor'] }), text('Title')]),
			p(text('hello '), el('strong', [text('bold')]), text(' and '), el('code', [text('code()')])),
			el('pre', [el('code', [text('const x = 1;')])]),
			el('figure', [el('figcaption', [text('caption')])], {
				dataRehypePrettyCodeFigure: true
			}),
			el('ul', [el('li', [text('outer'), el('ul', [el('li', [text('inner')])])])])
		);
		const blocks = collectAnchorBlocks(tree);
		expect(blockTexts(blocks)).toEqual(['Title', 'hello bold and code()', 'outer', 'inner']);
		expect(blocks.map((block) => block.ord)).toEqual([0, 1, 2, 3]);
	});

	it('treats a nested block as its own block and leaves the parent empty', () => {
		const tree = root(el('li', [p(text('loose item'))]));
		const blocks = collectAnchorBlocks(tree);
		expect(blocks.map((block) => block.text)).toEqual(['loose item']);
		expect(blocks[0].element.tagName).toBe('p');
	});

	it('folds whitespace globally across an inline void (E1 regression)', () => {
		const tree = root(p(text('a '), span(['katex'], [text('x')]), text(' b')));
		const blocks = collectAnchorBlocks(tree);
		// Per-node folding would produce "a  b" here; the grill measured the
		// two pipelines diverging on exactly this shape (inline math).
		expect(blocks[0].text).toBe('a b');
	});

	it('numbers duplicates with occ and keeps hashes stable', () => {
		const tree = root(p(text('same')), p(text('same')), p(text('other')));
		const blocks = collectAnchorBlocks(tree);
		expect(blocks[0].hash).toBe(blocks[1].hash);
		expect(blocks.map((block) => block.occ)).toEqual([0, 1, 0]);
		expect(blocks[2].hash).not.toBe(blocks[0].hash);
	});

	it('maps every normalized code point to a text node offset', () => {
		const family = '👨‍👩‍👧‍👦';
		const tree = root(p(text(`a ${family} b`)));
		const blocks = collectAnchorBlocks(tree);
		expect(blocks[0].text).toBe(`a ${family} b`);
		expect(blocks[0].points).toHaveLength([...blocks[0].text].length);
		// Every point points back into the same text node at a real offset.
		for (const point of blocks[0].points) {
			expect(point.node.type).toBe('text');
			expect(point.offset).toBeGreaterThanOrEqual(0);
			expect(point.offset).toBeLessThan(point.node.value.length);
		}
	});
});

describe('hashBlockText', () => {
	it('is a 10 hex sha256 prefix and deterministic', () => {
		expect(hashBlockText('hello')).toBe('2cf24dba5f');
		const a = hashBlockText('hello');
		expect(a).toMatch(/^[0-9a-f]{10}$/);
		expect(hashBlockText('hello')).toBe(a);
		expect(hashBlockText('hello!')).not.toBe(a);
	});
});

/* ── Read-side resolution ───────────────────────────────────────────────── */

function fixture(): { tree: HastRoot; blocks: AnchorBlock[] } {
	const tree = root(
		p(text('Intro paragraph.')),
		p(text('The quick brown fox jumps over the lazy dog.')),
		p(text('Tail paragraph.'))
	);
	return { tree, blocks: collectAnchorBlocks(tree) };
}

function anchorFor(
	blocks: AnchorBlock[],
	ord: number,
	phrase: string,
	quote = { prefix: '', suffix: '' }
) {
	const block = blocks.find((candidate) => candidate.ord === ord);
	if (!block) throw new Error('missing block');
	const at = block.text.indexOf(phrase);
	const start = [...block.text.slice(0, at)].length;
	const end = start + [...phrase].length;
	return {
		v: 1 as const,
		lang: 'en',
		block: { hash: block.hash, occ: block.occ, ord: block.ord },
		range: { start, end },
		quote: { exact: phrase, prefix: quote.prefix, suffix: quote.suffix }
	};
}

describe('resolveAnchor (read side, L0→L1→L2)', () => {
	it('hits at L0 when ord, range and quote agree', () => {
		const { blocks } = fixture();
		const anchor = anchorFor(blocks, 1, 'quick brown');
		const hit = resolveAnchor(blocks, anchor);
		expect(hit?.block.ord).toBe(1);
		expect(hit?.start).toBe(4);
	});

	it('re-finds a shifted quote inside the same block after an edit (L2)', () => {
		const { blocks } = fixture();
		const anchor = anchorFor(blocks, 1, 'quick brown');
		// A prefix was inserted inside the block: the hash changes, the quote and
		// the ord do not, so only the in-block quote search can save it.
		const edited = root(
			p(text('Intro paragraph.')),
			p(text('The very quick brown fox jumps over the lazy dog.')),
			p(text('Tail paragraph.'))
		);
		const hit = resolveAnchor(collectAnchorBlocks(edited), anchor);
		expect(hit?.block.ord).toBe(1);
		expect(hit?.start).toBe(9);
	});

	it('follows an identical block that moved when another block was inserted above (L1 hash path)', () => {
		const { blocks } = fixture();
		const anchor = anchorFor(blocks, 1, 'quick brown');
		const shifted = collectAnchorBlocks(
			root(p(text('Brand new opening.')), ...blocks.map((block) => block.element))
		);
		const hit = resolveAnchor(shifted, anchor);
		expect(hit?.block.ord).toBe(2);
		expect(hit?.start).toBe(4);
	});

	it('finds an edited block in the ±2 window when its ord also shifted (L2)', () => {
		const { blocks } = fixture();
		const anchor = anchorFor(blocks, 1, 'quick brown');
		const shifted = collectAnchorBlocks(
			root(
				p(text('Brand new opening.')),
				p(text('Intro paragraph.')),
				p(text('The very quick brown fox jumps over the lazy dog.')),
				p(text('Tail paragraph.'))
			)
		);
		const hit = resolveAnchor(shifted, anchor);
		expect(hit?.block.ord).toBe(2);
		expect(hit?.start).toBe(9);
	});

	it('uses prefix/suffix to pick the right occurrence inside one block', () => {
		const blocks = collectAnchorBlocks(root(p(text('foo bar foo baz'))));
		// A stale range points at the first `foo`; only the stored context can
		// disambiguate the second occurrence.
		const anchor = {
			v: 1 as const,
			lang: 'en',
			block: { hash: blocks[0].hash, occ: 0, ord: 0 },
			range: { start: 0, end: 3 },
			quote: { exact: 'foo', prefix: 'bar ', suffix: ' baz' }
		};
		const hit = resolveAnchor(blocks, anchor);
		expect(hit?.start).toBe(8);
	});

	it('misses when the quoted text is gone', () => {
		const { blocks } = fixture();
		const anchor = anchorFor(blocks, 1, 'quick brown');
		const rewritten = collectAnchorBlocks(root(p(text('Completely different text.'))));
		expect(resolveAnchor(rewritten, anchor)).toBeNull();
	});

	it('enumerates overlapping occurrences of the quote', () => {
		const blocks = collectAnchorBlocks(root(p(text('ababa'))));
		const anchor = {
			v: 1 as const,
			lang: 'en',
			block: { hash: blocks[0].hash, occ: 0, ord: 0 },
			range: { start: 2, end: 5 },
			quote: { exact: 'aba', prefix: 'ab', suffix: '' }
		};
		// The second "aba" starts inside the first one; stopping at the end of
		// each match hid it and resolved to the wrong span.
		expect(resolveAnchor(blocks, anchor)?.start).toBe(2);
	});

	it('uses the hint inside an overlapping run when context is ambiguous', () => {
		const blocks = collectAnchorBlocks(root(p(text('aaaa'))));
		const anchor = {
			v: 1 as const,
			lang: 'en',
			block: { hash: blocks[0].hash, occ: 0, ord: 0 },
			range: { start: 1, end: 4 },
			quote: { exact: 'aaa', prefix: '', suffix: '' }
		};
		// Both occurrences match the (empty) context; the stored start decides.
		expect(resolveAnchor(blocks, anchor)?.start).toBe(1);
	});

	it('resolves duplicate blocks by occ/context rather than by hash alone', () => {
		const tree = root(p(text('same sentence here')), p(text('same sentence here')));
		const blocks = collectAnchorBlocks(tree);
		const second = anchorFor(blocks, 1, 'sentence');
		const hit = resolveAnchor(blocks, second);
		expect(hit?.block.ord).toBe(1);
	});
});

/* ── Write-side validation ──────────────────────────────────────────────── */

describe('resolveAnchorDraft (write side, spec §6)', () => {
	it('accepts the exact block and derives prefix/suffix/lang', () => {
		const { blocks } = fixture();
		const draft = { ord: 1, start: 4, end: 15, exact: 'quick brown' };
		const result = resolveAnchorDraft(blocks, draft, 'en');
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.anchor.block.ord).toBe(1);
		expect(result.anchor.quote.exact).toBe('quick brown');
		expect(result.anchor.quote.prefix).toBe('The ');
		// suffix is capped at 24 code points (spec §4)
		expect(result.anchor.quote.suffix).toBe(' fox jumps over the lazy');
		expect(result.anchor.lang).toBe('en');
	});

	it('tolerates an offset shift inside the same block', () => {
		const { blocks } = fixture();
		const draft = { ord: 1, start: 0, end: 3, exact: 'quick brown' };
		const result = resolveAnchorDraft(blocks, draft, 'en');
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.anchor.range.start).toBe(4);
	});

	it('treats a mismatched block length as a stale ordinal (fingerprint)', () => {
		const { blocks } = fixture();
		const draft = { ord: 1, start: 4, end: 15, exact: 'quick brown', blockLength: 999 };
		// The slice at ord 1 still matches, but the reader saw a different block:
		// the ordinal must not be trusted (B2 review, angle 7).
		expect(resolveAnchorDraft(blocks, draft, 'en').kind).toBe('stale');
	});

	it('accepts the fingerprint when it matches', () => {
		const { blocks } = fixture();
		const length = [...blocks[1].text].length;
		const draft = { ord: 1, start: 4, end: 15, exact: 'quick brown', blockLength: length };
		expect(resolveAnchorDraft(blocks, draft, 'en').kind).toBe('ok');
	});

	it('tolerates an ord shift within the ±2 window', () => {
		const { blocks } = fixture();
		const draft = { ord: 3, start: 4, end: 15, exact: 'quick brown' };
		const result = resolveAnchorDraft(blocks, draft, 'en');
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.anchor.block.ord).toBe(1);
	});

	it('rejects a stale selection', () => {
		const { blocks } = fixture();
		const result = resolveAnchorDraft(
			blocks,
			{ ord: 1, start: 0, end: 5, exact: 'not here' },
			'en'
		);
		expect(result.kind).toBe('stale');
	});

	it('rejects a range that splits a grapheme cluster', () => {
		const family = '👨‍👩‍👧‍👦';
		const blocks = collectAnchorBlocks(root(p(text(`a${family}b`))));
		const split = [...blocks[0].text].slice(2, 4).join('');
		const result = resolveAnchorDraft(blocks, { ord: 0, start: 2, end: 4, exact: split }, 'en');
		expect(result.kind).toBe('stale');
	});
});

/* ── Marking ────────────────────────────────────────────────────────────── */

function markId(box: Element, tag = 'span'): Element[] {
	return box.children.filter(
		(child): child is Element => child.type === 'element' && child.tagName === tag
	);
}

function firstSpan(box: Element): Element | undefined {
	return markId(box)[0];
}

describe('applyAnchorMarks (spec §7/§12.6)', () => {
	it('wraps a plain range and preserves the text exactly', () => {
		const tree = root(p(text('hello world')));
		const blocks = collectAnchorBlocks(tree);
		const before = plain(tree);
		const placed = applyAnchorMarks(blocks, [
			{ commentId: 'c1', blockOrd: 0, start: 0, end: 5, pending: false }
		]);
		const spanEl = firstSpan(blocks[0].element);
		expect(spanEl?.tagName).toBe('span');
		expect(spanEl?.properties?.className).toEqual(['wl-cm']);
		expect(spanEl?.properties?.dataCid).toBe('c1');
		expect(spanEl?.properties?.id).toBe('c-c1');
		expect(plain(blocks[0].element)).toBe('hello world');
		expect(plain(tree)).toBe(before);
		expect(placed.get('c1')).toBe('c-c1');
	});

	it('splits across inline elements and places the id only once', () => {
		// (the id must land on the first span: a deep link to the tail would
		// scroll past the marked sentence)
		const tree = root(p(text('hello '), el('strong', [text('bold')]), text(' tail')));
		const blocks = collectAnchorBlocks(tree);
		const placed = applyAnchorMarks(blocks, [
			{ commentId: 'c1', blockOrd: 0, start: 3, end: 13, pending: false }
		]);
		const spans: Element[] = [];
		const collect = (node: Element) => {
			for (const child of node.children) {
				if (child.type !== 'element') continue;
				if (child.tagName === 'span' && child.properties?.dataCid === 'c1') spans.push(child);
				collect(child);
			}
		};
		collect(blocks[0].element);
		expect(spans.length).toBeGreaterThanOrEqual(2);
		const ids = spans.filter((spanEl) => spanEl.properties?.id);
		expect(ids).toHaveLength(1);
		expect(ids[0].properties?.id).toBe('c-c1');
		// First span in document order: a deep link to a later fragment would
		// scroll past the start of the marked sentence.
		expect(spans[0].properties?.id).toBe('c-c1');
		expect(plain(blocks[0].element)).toBe('hello bold tail');
		expect(placed.get('c1')).toBe('c-c1');
	});

	it('clusters identical ranges into one span carrying every id', () => {
		const tree = root(p(text('same range')));
		const blocks = collectAnchorBlocks(tree);
		const marks: AnchorMark[] = [
			{ commentId: 'c1', blockOrd: 0, start: 0, end: 4, pending: false },
			{ commentId: 'c2', blockOrd: 0, start: 0, end: 4, pending: true }
		];
		const placed = applyAnchorMarks(blocks, marks);
		const spans = markId(blocks[0].element).filter(
			(child) => child.properties?.dataCids === 'c1 c2'
		);
		expect(spans).toHaveLength(1);
		expect(spans[0].properties?.dataCid).toBe('c1');
		// Cluster is pending only when every member is pending (others may see it).
		expect(spans[0].properties?.className).toEqual(['wl-cm']);
		expect(placed.get('c1')).toBe('c-c1');
		expect(placed.get('c2')).toBe('c-c1');
	});

	it('splits an overlapping range into segments with the later start innermost', () => {
		const tree = root(p(text('abcdefghij')));
		const blocks = collectAnchorBlocks(tree);
		applyAnchorMarks(blocks, [
			{ commentId: 'outer', blockOrd: 0, start: 0, end: 8, pending: false },
			{ commentId: 'inner', blockOrd: 0, start: 3, end: 6, pending: false }
		]);
		// One span chain per contiguous segment: outer [0,3), outer+inner [3,6),
		// outer [6,8) — the inner span is the deepest in the middle segment, so a
		// click resolves to the innermost comment (spec §6).
		const top = markId(blocks[0].element);
		expect(top.map((spanEl) => spanEl.properties?.dataCid)).toEqual(['outer', 'outer', 'outer']);
		const middle = top[1];
		const nested = markId(middle)[0];
		expect(nested.properties?.dataCid).toBe('inner');
		expect(plain(middle)).toBe('def');
		expect(plain(blocks[0].element)).toBe('abcdefghij');
	});

	it('marks the viewer own pending comment with the dashed class', () => {
		const tree = root(p(text('pending text')));
		const blocks = collectAnchorBlocks(tree);
		applyAnchorMarks(blocks, [{ commentId: 'p1', blockOrd: 0, start: 0, end: 7, pending: true }]);
		expect(firstSpan(blocks[0].element)?.properties?.className).toEqual(['wl-cm', 'wl-cm-pending']);
	});

	it('leaves the tree untouched for an unknown block ordinal', () => {
		const tree = root(p(text('nothing to mark')));
		const blocks = collectAnchorBlocks(tree);
		const before = plain(tree);
		const placed = applyAnchorMarks(blocks, [
			{ commentId: 'x', blockOrd: 99, start: 0, end: 3, pending: false }
		]);
		expect(plain(tree)).toBe(before);
		expect(placed.get('x')).toBeNull();
	});
});

/* ── Schemas ────────────────────────────────────────────────────────────── */

describe('anchor schemas', () => {
	const valid = {
		v: 1,
		lang: 'zh-cn',
		block: { hash: 'abcdef0123', occ: 1, ord: 4 },
		range: { start: 3, end: 7 },
		quote: { exact: '选区文本', prefix: '', suffix: '' }
	};

	it('accepts a well-formed stored anchor', () => {
		expect(parseCommentAnchor(valid)).not.toBeNull();
		expect(commentAnchorSchema.safeParse(valid).success).toBe(true);
	});

	it('rejects version, hash and range violations', () => {
		expect(parseCommentAnchor({ ...valid, v: 2 })).toBeNull();
		expect(parseCommentAnchor({ ...valid, block: { ...valid.block, hash: 'XYZ' } })).toBeNull();
		expect(parseCommentAnchor({ ...valid, range: { start: 5, end: 6 } })).toBeNull();
		expect(parseCommentAnchor({ ...valid, range: { start: 5, end: 600 } })).toBeNull();
	});

	it('rejects a stored quote whose length disagrees with its range', () => {
		expect(
			parseCommentAnchor({
				...valid,
				range: { start: 3, end: 9 },
				quote: { ...valid.quote, exact: '选区文本' }
			})
		).toBeNull();
		expect(
			parseCommentAnchor({
				...valid,
				range: { start: 3, end: 4 },
				quote: { ...valid.quote, exact: '选' }
			})
		).toBeNull();
	});

	it('counts quote bounds in code points', () => {
		const exact = '👨‍👩‍👧‍👦'.repeat(20); // 140 code points, 220 UTF-16 units
		expect(
			parseCommentAnchor({
				...valid,
				range: { start: 0, end: 140 },
				quote: { exact, prefix: '', suffix: '' }
			})
		).not.toBeNull();
		const tooLong = '👨‍👩‍👧‍👦'.repeat(80); // 560 code points
		expect(
			parseCommentAnchor({
				...valid,
				range: { start: 0, end: 560 },
				quote: { exact: tooLong, prefix: '', suffix: '' }
			})
		).toBeNull();
	});

	it('parses the client draft (ord + range + exact only)', () => {
		expect(parseCommentAnchorDraft({ ord: 2, start: 0, end: 4, exact: 'text' })).toEqual({
			ord: 2,
			start: 0,
			end: 4,
			exact: 'text'
		});
		expect(parseCommentAnchorDraft({ ord: -1, start: 0, end: 4, exact: 'text' })).toBeNull();
		expect(parseCommentAnchorDraft({ ord: 0, start: 4, end: 4, exact: 'text' })).toBeNull();
	});

	it('applies the stored [2, 500] window to drafts as well', () => {
		// A 1-code-point range used to pass the draft schema, get stored, and then
		// be rejected by the read schema - the comment silently lost its anchor.
		expect(parseCommentAnchorDraft({ ord: 0, start: 0, end: 1, exact: 'x' })).toBeNull();
		expect(
			parseCommentAnchorDraft({ ord: 0, start: 0, end: 501, exact: 'x'.repeat(501) })
		).toBeNull();
		expect(
			parseCommentAnchorDraft({ ord: 0, start: 0, end: 501, exact: 'x'.repeat(500) + 'y' })
		).toBeNull();
	});
});
