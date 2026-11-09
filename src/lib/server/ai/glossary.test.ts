import { describe, expect, it } from 'vitest';
import {
	glossaryPromptBlock,
	MAX_TERMS,
	selectGlossaryTerms,
	verifyGlossary,
	type GlossaryEntry
} from './glossary.ts';

function term(overrides: Partial<GlossaryEntry> & { term: string }): GlossaryEntry {
	return {
		translation: `T(${overrides.term})`,
		note: null,
		caseSensitive: false,
		...overrides
	};
}

describe('selectGlossaryTerms', () => {
	it('injects only terms that occur in the source', () => {
		const rows = [term({ term: 'lair' }), term({ term: 'absent' })];
		const selected = selectGlossaryTerms(rows, 'Welcome to the Lair.');
		expect(selected.map((entry) => entry.term)).toEqual(['lair']);
	});

	it('respects caseSensitive, and ignores case otherwise', () => {
		const rows = [
			term({ term: 'Lair', caseSensitive: true }),
			term({ term: 'garden', caseSensitive: false })
		];
		const selected = selectGlossaryTerms(rows, 'the lair and the GARDEN');
		expect(selected.map((entry) => entry.term)).toEqual(['garden']);
	});

	it('ranks by hit count, then by term length', () => {
		const rows = [
			term({ term: 'quill' }),
			term({ term: 'note' }),
			term({ term: 'digital garden' })
		];
		const selected = selectGlossaryTerms(rows, 'note note digital garden note');
		expect(selected.map((entry) => entry.term)).toEqual(['note', 'digital garden']);
		expect(selected[0]?.hits).toBe(3);
	});

	it('caps the injected set so a long table cannot dwarf the text', () => {
		const rows = Array.from({ length: MAX_TERMS + 5 }, (_, index) =>
			term({ term: `word${index}` })
		);
		const text = rows.map((row) => row.term).join(' ');
		expect(selectGlossaryTerms(rows, text)).toHaveLength(MAX_TERMS);
	});

	it('stops before a term would push the block past its character budget', () => {
		const long = 'x'.repeat(600);
		const rows = [
			term({ term: 'alpha', translation: long }),
			term({ term: 'beta', translation: long })
		];
		// 600 + 600 + separators is over MAX_CHARS, so only the first survives.
		expect(selectGlossaryTerms(rows, 'alpha beta').map((entry) => entry.term)).toEqual(['alpha']);
	});
});

describe('glossaryPromptBlock', () => {
	it('renders a dash-free list with notes when present', () => {
		const block = glossaryPromptBlock([
			{ term: 'lair', translation: '巢穴', note: 'site name', caseSensitive: false },
			{ term: 'note', translation: '手记', note: null, caseSensitive: false }
		]);
		expect(block).toContain('Use these glossary translations exactly:');
		expect(block).toContain('- lair → 巢穴 (site name)');
		expect(block).toContain('- note → 手记');
	});

	it('is null when nothing matched', () => {
		expect(glossaryPromptBlock([])).toBeNull();
	});
});

describe('verifyGlossary', () => {
	it('reports a term whose translation never appears', () => {
		const entries = [
			{ term: 'lair', translation: '巢穴', note: null, caseSensitive: false },
			{ term: 'note', translation: '手记', note: null, caseSensitive: false }
		];
		expect(verifyGlossary(entries, '欢迎来到巢穴。')).toEqual([{ term: 'note', expected: '手记' }]);
	});

	it('is case-insensitive for a case-insensitive term', () => {
		const entries = [{ term: 'lair', translation: 'Lair', note: null, caseSensitive: false }];
		expect(verifyGlossary(entries, 'the LAIR')).toEqual([]);
	});
});
