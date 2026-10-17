import { describe, expect, it } from 'vitest';
import {
	ANCHOR_MAX_LENGTH,
	ANCHOR_MIN_LENGTH,
	ANCHOR_QUOTE_DISPLAY_MAX,
	codePointLength,
	codePointSlice,
	codePointToUtf16,
	isAnchorBlock,
	isAnchorSkipped,
	quoteDisplay,
	splitsSurrogatePair,
	utf16ToCodePoint,
	type AnchorElementShape
} from './comment-anchor';

const el = (
	tag: string,
	className: readonly string[] = [],
	attrs: readonly string[] = []
): AnchorElementShape => ({
	tag,
	className,
	hasAttr: (name) => attrs.includes(name)
});

describe('code point offsets (spec §3 / W3C §4.2.4)', () => {
	const family = '👨‍👩‍👧‍👦';
	const text = `a${family}b`;

	it('counts code points, not UTF-16 units', () => {
		expect(text.length).toBe(13);
		expect(codePointLength(text)).toBe(9);
	});

	it('bridges UTF-16 and code point offsets', () => {
		expect(utf16ToCodePoint(text, text.indexOf('b'))).toBe(8);
		expect(codePointToUtf16(text, 8)).toBe(12);
		expect(codePointSlice(text, 0, 1)).toBe('a');
		expect(codePointSlice(text, 1, 8)).toBe(family);
	});

	it('detects an offset that splits a surrogate pair', () => {
		expect(splitsSurrogatePair(text, 1)).toBe(false); // between "a" and the family
		expect(splitsSurrogatePair(text, 2)).toBe(true); // inside the pair
		expect(splitsSurrogatePair(text, 0)).toBe(false);
		expect(splitsSurrogatePair(text, text.length)).toBe(false);
	});
});

describe('block model', () => {
	it('accepts every anchorable leaf block, including list and table cells', () => {
		for (const tag of ['p', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'figcaption']) {
			expect(isAnchorBlock(el(tag)), tag).toBe(true);
		}
	});

	it('rejects the excluded subtrees (code, math, embeds, layout, footnotes, anchors)', () => {
		expect(isAnchorSkipped(el('pre'))).toBe(true);
		expect(isAnchorSkipped(el('hr'))).toBe(true);
		expect(isAnchorSkipped(el('img'))).toBe(true);
		expect(isAnchorSkipped(el('input'))).toBe(true);
		expect(isAnchorSkipped(el('details', ['md-details']))).toBe(true);
		expect(isAnchorSkipped(el('span', ['katex']))).toBe(true);
		expect(isAnchorSkipped(el('div', ['mermaid']))).toBe(true);
		expect(isAnchorSkipped(el('div', ['md-grid', 'md-grid-cols-2']))).toBe(true);
		expect(isAnchorSkipped(el('div', ['md-tabs']))).toBe(true);
		expect(isAnchorSkipped(el('a', ['embed-card']))).toBe(true);
		expect(isAnchorSkipped(el('a', ['md-anchor']))).toBe(true);
		expect(isAnchorSkipped(el('sup', [], ['data-footnote-ref']))).toBe(true);
		expect(isAnchorSkipped(el('section', [], ['data-footnotes']))).toBe(true);
		expect(isAnchorSkipped(el('figure', [], ['data-rehype-pretty-code-figure']))).toBe(true);
	});

	it('keeps inline code as text (W3C: remove tags, keep content)', () => {
		expect(isAnchorSkipped(el('code'))).toBe(false);
		// ...but inline code is not itself a block: its text belongs to the nearest block.
		expect(isAnchorBlock(el('code'))).toBe(false);
		expect(isAnchorBlock(el('strong'))).toBe(false);
	});
});

describe('quoteDisplay', () => {
	it('caps by code points and marks the cut', () => {
		const exact = 'x'.repeat(ANCHOR_QUOTE_DISPLAY_MAX + 10);
		const shown = quoteDisplay(exact);
		expect(codePointLength(shown)).toBe(ANCHOR_QUOTE_DISPLAY_MAX);
		expect(shown.endsWith('…')).toBe(true);
		expect(quoteDisplay('short')).toBe('short');
	});

	it('counts code points, so an emoji costs its true length, not its UTF-16 units', () => {
		// One family emoji = 7 code points (4 emoji + 3 ZWJ) and 11 UTF-16 units:
		// the cap must be measured in code points (spec §3), and the cut is marked.
		const exact = '👨‍👩‍👧‍👦'.repeat(30);
		expect(codePointLength(exact)).toBe(210);
		const shown = quoteDisplay(exact);
		expect(codePointLength(shown)).toBe(ANCHOR_QUOTE_DISPLAY_MAX);
		expect(shown.endsWith('…')).toBe(true);
	});
});

describe('bounds', () => {
	it('keeps the spec window', () => {
		expect(ANCHOR_MIN_LENGTH).toBe(2);
		expect(ANCHOR_MAX_LENGTH).toBe(500);
	});
});
