import { afterEach, describe, expect, it } from 'vitest';
import { renderMarkdownToHtmlSync } from '$lib/components/markdown/editor/markdown-config';
import { codePointSlice } from '$lib/utils/comment-anchor';
import { collectDomBlocks, selectionToAnchor } from './segment-dom';
import { SEGMENT_FIXTURES } from './segment-fixtures';

/**
 * Browser half of the two-pipeline conformance check (comment P3b, spec §3/§5).
 * `comment-anchor.conformance.test.ts` asserts the same expected texts on the
 * server walker; these cases pin the DOM walker plus selection -> (ord, range,
 * exact), including the code-point boundary rule (W3C §4.2.4).
 */
const hosts: HTMLElement[] = [];

function mount(html: string): HTMLElement {
	const host = document.createElement('div');
	host.className = 'markdown-body';
	host.innerHTML = html;
	document.body.appendChild(host);
	hosts.push(host);
	return host;
}

function mountMarkdown(markdown: string): HTMLElement {
	return mount(renderMarkdownToHtmlSync(markdown));
}

function texts(host: HTMLElement): string[] {
	return collectDomBlocks(host).map((block) => block.text);
}

function select(
	startNode: Node,
	startOffset: number,
	endNode: Node = startNode,
	endOffset: number = startOffset
): Selection {
	const range = document.createRange();
	range.setStart(startNode, startOffset);
	range.setEnd(endNode, endOffset);
	const selection = window.getSelection();
	if (!selection) throw new Error('no selection');
	selection.removeAllRanges();
	selection.addRange(range);
	return selection;
}

afterEach(() => {
	for (const host of hosts.splice(0)) host.remove();
	window.getSelection()?.removeAllRanges();
});

describe('DOM block directory conformance', () => {
	for (const fixture of SEGMENT_FIXTURES) {
		it(fixture.name, () => {
			expect(texts(mountMarkdown(fixture.markdown))).toEqual(fixture.blocks);
		});
	}

	it('skips a figure wrapper that contains a code block', () => {
		const host = mount(
			'<figure class="shiki" data-rehype-pretty-code-figure=""><pre><code>skip me</code></pre></figure><p>kept</p>'
		);
		expect(texts(host)).toEqual(['kept']);
	});
});

describe('selection to anchor', () => {
	it('maps a selection inside inline elements to block offsets', () => {
		const host = mountMarkdown(SEGMENT_FIXTURES[1].markdown);
		const strong = host.querySelector('strong');
		const node = strong?.firstChild;
		expect(node).toBeInstanceOf(Text);
		const selection = select(node as Text, 0, node as Text, 4); // "bold"
		const found = selectionToAnchor(host, selection);
		expect(found).not.toBeNull();
		expect(found?.ord).toBe(0);
		expect(found?.exact).toBe('bold');
		const block = collectDomBlocks(host)[0];
		expect(codePointSlice(block.text, found!.start, found!.end)).toBe('bold');
	});

	it('handles element-container endpoints from selectNodeContents', () => {
		const host = mountMarkdown('paragraph one');
		const paragraph = host.querySelector('p');
		expect(paragraph).not.toBeNull();
		const range = document.createRange();
		range.selectNodeContents(paragraph as HTMLElement);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		const found = selectionToAnchor(host, selection as Selection);
		expect(found).toMatchObject({ ord: 0, start: 0, end: 13, exact: 'paragraph one' });
	});

	it('maps astral text to code-point offsets, not UTF-16 units', () => {
		const host = mountMarkdown('a👨‍👩‍👧‍👦b tail');
		const block = collectDomBlocks(host)[0];
		expect([...block.text].length).toBe(14);
		const node = host.querySelector('p')?.firstChild as Text;
		// "a" + 4 emoji (2 units each) + 3 ZWJ + "b tail"
		expect(node.data.length).toBe(18);
		const selection = select(node, 12, node, 18); // "b tail"
		const found = selectionToAnchor(host, selection);
		expect(found).toMatchObject({ start: 8, end: 14, exact: 'b tail' });
	});

	it('rejects a cross-block selection', () => {
		const host = mountMarkdown(SEGMENT_FIXTURES[2].markdown);
		const heading = host.querySelector('h2')?.firstChild as Text;
		const paragraph = host.querySelector('p')?.firstChild as Text;
		const selection = select(heading, 0, paragraph, 4);
		expect(selectionToAnchor(host, selection)).toBeNull();
	});

	it('rejects a selection inside a skipped code block', () => {
		const host = mountMarkdown(SEGMENT_FIXTURES[7].markdown);
		const code = host.querySelector('pre code');
		expect(code).not.toBeNull();
		const walker = document.createTreeWalker(code as HTMLElement, NodeFilter.SHOW_TEXT);
		const node = walker.nextNode() as Text;
		expect(node).not.toBeNull();
		const selection = select(node, 0, node, Math.min(5, node.data.length));
		expect(selectionToAnchor(host, selection)).toBeNull();
	});

	it('rejects one-character selections (minimum length 2)', () => {
		const host = mountMarkdown('abcdef');
		const node = host.querySelector('p')?.firstChild as Text;
		const selection = select(node, 2, node, 3);
		expect(selectionToAnchor(host, selection)).toBeNull();
	});

	it('rejects selections outside the article root', () => {
		const host = mountMarkdown('abcdef');
		const outside = mount('<p>elsewhere</p>');
		const node = outside.querySelector('p')?.firstChild as Text;
		const selection = select(node, 0, node, 4);
		expect(selectionToAnchor(host, selection)).toBeNull();
	});

	it('rejects a selection that cuts a grapheme cluster', () => {
		const host = mountMarkdown('a👨‍👩‍👧‍👦b tail');
		const node = host.querySelector('p')?.firstChild as Text;
		// 3 is inside the ZWJ family (after the first member), not a cluster edge.
		const selection = select(node, 3, node, 18);
		expect(selectionToAnchor(host, selection)).toBeNull();
	});

	it('rejects selections longer than the 500 code point bound', () => {
		const host = mountMarkdown('x'.repeat(600));
		const node = host.querySelector('p')?.firstChild as Text;
		const selection = select(node, 0, node, 501);
		expect(selectionToAnchor(host, selection)).toBeNull();
	});

	it('rejects an endpoint inside a void subtree', () => {
		const host = mount('<p>before<span class="katex">x</span>after</p>');
		const katex = host.querySelector('.katex')?.firstChild as Text;
		expect(katex).toBeInstanceOf(Text);
		const selection = select(katex, 0, katex, 1);
		expect(selectionToAnchor(host, selection)).toBeNull();
	});

	it('maps plain selections to the same code-point offsets the server stores', () => {
		const cases: Array<{ markdown: string; needle: string; start: number; end: number }> = [
			{ markdown: 'Hello world.', needle: 'world', start: 6, end: 11 },
			// Folded text is "one two": the DOM node still holds the raw runs.
			{ markdown: 'one   two', needle: 'two', start: 4, end: 7 },
			{ markdown: 'one\ntwo', needle: 'two', start: 4, end: 7 },
			{ markdown: 'a👨‍👩‍👧‍👦b tail', needle: 'b tail', start: 8, end: 14 }
		];
		for (const testCase of cases) {
			const host = mountMarkdown(testCase.markdown);
			const node = host.querySelector('p')?.firstChild as Text;
			const at = node.data.indexOf(testCase.needle);
			const selection = select(node, at, node, at + testCase.needle.length);
			const found = selectionToAnchor(host, selection);
			expect(found, testCase.markdown).toMatchObject({
				start: testCase.start,
				end: testCase.end,
				exact: testCase.needle
			});
		}
	});
});

