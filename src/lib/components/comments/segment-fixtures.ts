/**
 * Shared conformance fixtures for the two block pipelines (comment P3b, spec §3).
 *
 * The server derives blocks from the rendered hast tree, the reader from the
 * live DOM. They are separate implementations by construction, so both are
 * checked against the same expected normalized text — that is what keeps
 * "reader selection -> ord/range" stable after a page round-trip.
 *
 * Keep these fixtures free of features the light (client) pipeline renders
 * differently from the server one (math/syntax highlighting): the invariant is
 * about block text, not about markup.
 */
export interface SegmentFixture {
	name: string;
	markdown: string;
	/** Normalized block texts, in document order (spec §3). */
	blocks: string[];
}

export const SEGMENT_FIXTURES: SegmentFixture[] = [
	{ name: 'paragraph', markdown: 'Hello world.', blocks: ['Hello world.'] },
	{
		name: 'inline elements',
		markdown: 'a **bold** and *italic* plus [link](https://example.com) and `code` end',
		blocks: ['a bold and italic plus link and code end']
	},
	{
		name: 'heading and paragraph',
		markdown: '## Title\n\nBody text here.',
		blocks: ['Title', 'Body text here.']
	},
	{
		name: 'list items',
		markdown: '- first item\n- second item',
		blocks: ['first item', 'second item']
	},
	{
		name: 'nested list',
		markdown: '- outer one\n  - inner one\n- outer two',
		blocks: ['outer one', 'inner one', 'outer two']
	},
	{ name: 'whitespace folding', markdown: 'one   two\n\nthree', blocks: ['one two', 'three'] },
	{ name: 'soft break', markdown: 'one\ntwo', blocks: ['one two'] },
	{
		name: 'code fence skipped',
		markdown: 'before\n\n```js\nconst x = 1;\n```\n\nafter',
		blocks: ['before', 'after']
	},
	{
		name: 'table cells',
		markdown: '| a | b |\n| --- | --- |\n| 1 | 2 |',
		blocks: ['a', 'b', '1', '2']
	},
	{ name: 'blockquote paragraph', markdown: '> quoted text', blocks: ['quoted text'] },
	{ name: 'astral text', markdown: 'a👨‍👩‍👧‍👦b', blocks: ['a👨‍👩‍👧‍👦b'] }
];
