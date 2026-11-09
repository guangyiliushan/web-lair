import { describe, expect, it } from 'vitest';
import { joinChunks, segmentMarkdown } from './segment';

/**
 * The chunker is the only place a long document is cut, and the cut must be
 * structural: a `[[WL…]]` placeholder, a table row or a sentence is never
 * sliced in half. These tests pin the cut points and the reassembly contract
 * (`joinChunks` reproduces the normalised source for everything but tables).
 */

describe('segmentMarkdown', () => {
	it('returns no chunks for an empty document', () => {
		expect(segmentMarkdown('', { maxChars: 100 })).toEqual([]);
		expect(segmentMarkdown('   \n\n  ', { maxChars: 100 })).toEqual([]);
	});

	it('keeps a short document in one chunk', () => {
		const chunks = segmentMarkdown('# Title\n\nA short body.', { maxChars: 100 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe('# Title\n\nA short body.');
		expect(chunks[0].separator).toBe('');
		expect(chunks[0].heading).toBe('Title');
	});

	it('packs paragraphs until the budget', () => {
		const source = 'aaaa\n\nbbbb\n\ncccc';
		const chunks = segmentMarkdown(source, { maxChars: 20 });
		expect(chunks).toHaveLength(1);
		expect(joinChunks(chunks)).toBe(source);
	});

	it('splits between paragraphs when the budget closes', () => {
		const source = 'aaaa\n\nbbbb\n\ncccc';
		const chunks = segmentMarkdown(source, { maxChars: 5 });
		expect(chunks.map((chunk) => chunk.text)).toEqual(['aaaa', 'bbbb', 'cccc']);
		expect(chunks.map((chunk) => chunk.separator)).toEqual(['', '\n\n', '\n\n']);
		expect(joinChunks(chunks)).toBe(source);
	});

	it('splits an oversized paragraph at sentence ends and rejoins exactly', () => {
		const source = '第一句。第二句。第三句。';
		const chunks = segmentMarkdown(source, { maxChars: 5 });
		expect(chunks.map((chunk) => chunk.text)).toEqual(['第一句。', '第二句。', '第三句。']);
		// Sentence pieces rejoin with no separator: the punctuation carries it.
		expect(chunks.map((chunk) => chunk.separator)).toEqual(['', '', '']);
		expect(joinChunks(chunks)).toBe(source);
	});

	it('never cuts inside a protected placeholder', () => {
		const source = `${'a'.repeat(9)}[[WL12]]${'b'.repeat(10)}`;
		const chunks = segmentMarkdown(source, { maxChars: 12 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.text.split('[[').length).toBe(chunk.text.split(']]').length);
		}
		expect(joinChunks(chunks)).toBe(source);
	});

	it('splits list items on line boundaries', () => {
		const source = '- one\n- two\n- three';
		const chunks = segmentMarkdown(source, { maxChars: 7 });
		expect(chunks.map((chunk) => chunk.separator)).toEqual(['', '\n', '\n']);
		expect(joinChunks(chunks)).toBe(source);
	});

	it('repeats the table header on every part', () => {
		const source = ['| A | B |', '| - | - |', '| 1 | 1 |', '| 2 | 2 |', '| 3 | 3 |'].join('\n');
		const chunks = segmentMarkdown(source, { maxChars: 25 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.text.startsWith('| A | B |\n| - | - |')).toBe(true);
		}
	});

	it('packs a short multi-section document into one chunk', () => {
		const source = '# A\n\none\n\n## B\n\ntwo\n\n## C\n\nthree';
		const chunks = segmentMarkdown(source, { maxChars: 1000 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].heading).toBe('A');
		expect(joinChunks(chunks)).toBe(source);
	});

	it('tracks the nearest heading per chunk', () => {
		const source = '# Alpha\n\n第一段。\n\n## Beta\n\n第二段。';
		const chunks = segmentMarkdown(source, { maxChars: 10 });
		expect(chunks.map((chunk) => chunk.heading)).toEqual(['Alpha', 'Alpha', 'Beta', 'Beta']);
	});

	it('rejects a non-positive budget', () => {
		expect(() => segmentMarkdown('text', { maxChars: 0 })).toThrow(RangeError);
		expect(() => segmentMarkdown('text', { maxChars: Number.NaN })).toThrow(RangeError);
	});
});
