import { describe, expect, it } from 'vitest';
import { conformanceCases } from '$lib/components/markdown/testing/conformance-cases';
import { applyAnchorMarks, collectAnchorBlocks } from './comment-anchor';
import { renderMarkdownToHtml, renderMarkdownTree, stringifyMarkdownTree } from './markdown';

/**
 * Tree-mode rendering must not become a second pipeline (comment P3b, spec §7).
 * Without marks, `run()` + `stringify()` has to produce exactly the bytes the
 * existing `renderMarkdownToHtml` produces — otherwise RSS, the editor preview
 * and the comment read path would drift apart.
 */
const FIXTURES: Array<{ name: string; markdown: string }> = [
	{ name: 'heading + emphasis', markdown: '# Title\n\nSome *emphasis* and **strong** text.' },
	{ name: 'fenced code', markdown: '```ts title="demo"\nconst a = 1;\n```' },
	{ name: 'table', markdown: '| a | b |\n| --- | --- |\n| 1 | 2 |' },
	{ name: 'inline + display math', markdown: 'Inline $x^2$ and\n\n$$\n\\int_0^1 x\\,dx\n$$' },
	{ name: 'nested list', markdown: '- one\n  - two\n- three' },
	{ name: 'alert + spoiler', markdown: '> [!NOTE]\n> Heads up\n\n剧透 ||hidden|| 结束' },
	{ name: 'footnote', markdown: 'Body[^1]\n\n[^1]: note text' },
	{ name: 'raw whitelist', markdown: 'a <mark>highlighted</mark> word' }
];

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '');
const codePointCount = (value: string) => [...value].length;

async function renderDoc(markdown: string) {
	const tree = await renderMarkdownTree(markdown);
	return { tree, html: await stringifyMarkdownTree(tree) };
}

describe('tree-mode rendering (spec §7: same compiler, no second pipeline)', () => {
	it('returns an empty document for empty input', async () => {
		const doc = await renderDoc('');
		expect(doc.html).toBe('');
		expect(doc.tree.type).toBe('root');
		expect(doc.tree.children).toHaveLength(0);
	});

	for (const fixture of FIXTURES) {
		it(`matches renderMarkdownToHtml byte-for-byte: ${fixture.name}`, async () => {
			const doc = await renderDoc(fixture.markdown);
			const legacy = await renderMarkdownToHtml(fixture.markdown);
			expect(doc.html).toBe(legacy);
			expect(await stringifyMarkdownTree(doc.tree)).toBe(legacy);
		});
	}

	it('keeps the tree usable for anchors and preserves the text after marking', async () => {
		// h1 is the page title (rendered outside the article), so the block set
		// starts at h2 — the fixture uses h2 on purpose.
		const markdown = '## Title\n\nSome paragraph with **bold** and `code` here.\n\nTail paragraph.';
		const doc = await renderDoc(markdown);
		const blocks = collectAnchorBlocks(doc.tree);
		expect(blocks.map((block) => block.text)).toEqual([
			'Title',
			'Some paragraph with bold and code here.',
			'Tail paragraph.'
		]);

		const target = blocks[1];
		applyAnchorMarks(blocks, [
			{
				commentId: 'c1',
				blockOrd: target.ord,
				start: 0,
				end: codePointCount(target.text),
				pending: false
			}
		]);
		const marked = await stringifyMarkdownTree(doc.tree);

		expect(marked).toContain('class="wl-cm"');
		expect(marked).toContain('id="c-c1"');
		// The inline elements split the range, so more than one span is expected.
		expect(marked.match(/class="wl-cm"/g)?.length ?? 0).toBeGreaterThan(1);
		expect(stripTags(marked)).toBe(stripTags(doc.html));
	});

	it('keeps footnote markers and the footnote area out of the block text', async () => {
		const tree = await renderMarkdownTree('Body with a footnote[^1].\n\n[^1]: note text');
		const blocks = collectAnchorBlocks(tree);
		// The reference superscript and the footnote section are skipped by
		// attribute (data-footnote-ref / data-footnotes); a camelCase drift in
		// the hast attribute adapter would leak "1" and the note text here.
		expect(blocks.map((block) => block.text)).toEqual(['Body with a footnote.']);
	});

	it('keeps heading anchor links out of the block text', async () => {
		const tree = await renderMarkdownTree('## Section {#custom}\n\nbody');
		const blocks = collectAnchorBlocks(tree);
		expect(blocks[0].text).toBe('Section');
	});

	it('skips the whole pretty-code figure, including its caption', async () => {
		// The wrapper is matched structurally (figure containing pre): the data-*
		// marker does not survive every sanitize revision, and a surviving caption
		// used to become an anchorable block that shifted every later ord.
		const tree = await renderMarkdownTree(
			'```ts title="demo"\nconst a = 1;\n```\n\nAfter the block.'
		);
		const blocks = collectAnchorBlocks(tree);
		expect(blocks.map((block) => block.text)).toEqual(['After the block.']);
		expect(blocks[0].ord).toBe(0);
	});
});

/**
 * Spec §12.6: the cut-and-wrap pass must never change the block text. Runs over
 * the whole shared conformance corpus (the same fixtures the markdown pipeline
 * is pinned to), not a couple of hand-written snippets.
 */
describe('mark splitting preserves every block text (spec §12.6)', () => {
	it.each(conformanceCases)('$id', async (testCase) => {
		const tree = await renderMarkdownTree(testCase.input);
		const blocks = collectAnchorBlocks(tree);
		const before = blocks.map((block) => block.text);
		const target = blocks.find((block) => codePointCount(block.text) >= 2);
		if (target) {
			applyAnchorMarks(blocks, [
				{ commentId: 'probe', blockOrd: target.ord, start: 0, end: 2, pending: false }
			]);
			expect(collectAnchorBlocks(tree).map((block) => block.text)).toEqual(before);
		}
		// Whatever the fixture renders, marking must leave the visible text alone.
		const markedHtml = await stringifyMarkdownTree(tree);
		const unmarkedHtml = await stringifyMarkdownTree(await renderMarkdownTree(testCase.input));
		expect(stripTags(markedHtml)).toBe(stripTags(unmarkedHtml));
	});

	it('keeps every block text on a long mixed article after marking', async () => {
		const markdown = [
			'# Heading one',
			'',
			'Opening paragraph with `inline code`, a [link](https://example.com) and **strong** text.',
			'',
			'## Section two',
			'',
			'- first bullet',
			'- second bullet with $x^2$ math',
			'',
			'| a | b |',
			'| --- | --- |',
			'| 1 | 2 |',
			'',
			'> quoted paragraph',
			'',
			'```ts',
			'const a = 1;',
			'```',
			'',
			'Closing paragraph with a footnote[^1].',
			'',
			'[^1]: footnote text'
		].join('\n');
		const tree = await renderMarkdownTree(markdown);
		const blocks = collectAnchorBlocks(tree);
		const before = blocks.map((block) => block.text);
		const marks = blocks
			.filter((block) => codePointCount(block.text) >= 6)
			.map((block) => ({
				commentId: `probe-${block.ord}`,
				blockOrd: block.ord,
				start: 1,
				end: Math.min(5, codePointCount(block.text)),
				pending: block.ord % 2 === 0
			}));
		applyAnchorMarks(blocks, marks);
		expect(collectAnchorBlocks(tree).map((block) => block.text)).toEqual(before);
		const marked = await stringifyMarkdownTree(tree);
		expect(stripTags(marked)).toBe(stripTags(await renderMarkdownToHtml(markdown)));
	});
});
