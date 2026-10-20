import { describe, expect, it } from 'vitest';
import {
	isEmptyProvenance,
	normalizeProvenance,
	postProvenanceFromPayload
} from './post-provenance';

describe('normalizeProvenance', () => {
	it('keeps only known enum values and normalizes comma-separated help', () => {
		expect(
			normalizeProvenance({
				writingOrigin: 'assist',
				visualOrigin: 'some',
				aiHelp: ' ideas, wording, ideas, '
			})
		).toEqual({
			writingOrigin: 'assist',
			visualOrigin: 'some',
			aiHelp: ['ideas', 'wording']
		});
	});

	it('degrades unknown values to undisclosed instead of inventing a claim', () => {
		expect(
			normalizeProvenance({
				writingOrigin: 'human-ish',
				visualOrigin: 'none-ish',
				aiHelp: ['', 'x'.repeat(41)]
			})
		).toEqual({ writingOrigin: null, visualOrigin: null, aiHelp: [] });
	});

	it('caps the optional detail list', () => {
		const help = Array.from({ length: 12 }, (_, i) => `h${i}`);
		expect(normalizeProvenance({ writingOrigin: 'assist', aiHelp: help }).aiHelp).toHaveLength(8);
	});

	it('drops help that contradicts an explicit no-AI/undisclosed writing claim', () => {
		expect(normalizeProvenance({ writingOrigin: 'none', aiHelp: ['ideas'] }).aiHelp).toEqual([]);
		expect(normalizeProvenance({ aiHelp: ['ideas'] }).aiHelp).toEqual([]);
	});
});

describe('postProvenanceFromPayload', () => {
	it('distinguishes an absent payload from an explicit undisclosed object', () => {
		expect(postProvenanceFromPayload(null)).toBeNull();
		expect(postProvenanceFromPayload({ title: {} })).toBeNull();
		expect(postProvenanceFromPayload({ provenance: {} })).toEqual({
			writingOrigin: null,
			visualOrigin: null,
			aiHelp: []
		});
	});

	it('reads a valid staged provenance block', () => {
		expect(
			postProvenanceFromPayload({
				provenance: { writingOrigin: 'mostly_ai', visualOrigin: 'all', aiHelp: ['outline'] }
			})
		).toEqual({ writingOrigin: 'mostly_ai', visualOrigin: 'all', aiHelp: ['outline'] });
	});

	it('reports empty vs non-empty', () => {
		expect(isEmptyProvenance({ writingOrigin: null, visualOrigin: null, aiHelp: [] })).toBe(true);
		expect(isEmptyProvenance({ writingOrigin: 'none', visualOrigin: null, aiHelp: [] })).toBe(
			false
		);
	});
});
