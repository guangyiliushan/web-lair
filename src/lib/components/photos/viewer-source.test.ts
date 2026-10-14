import { describe, expect, it } from 'vitest';
import { fullSrcFromDisplay, mimeFromSrc, plainLabel } from './viewer-source';

/** 3d source adaptation: the @full derivation rule (Q11) and label fallback. */
describe('fullSrcFromDisplay (Q11 lightbox derivation)', () => {
	const key = `ab/ab${'1'.repeat(62)}`;
	const origin = 'https://lair.example';

	it('derives @full from the display variants', () => {
		expect(fullSrcFromDisplay(`/i/${key}.png@preview`)).toBe(`/i/${key}.png@full`);
		expect(fullSrcFromDisplay(`/i/${key}.png@thumb`)).toBe(`/i/${key}.png@full`);
		expect(fullSrcFromDisplay(`/i/${key}.png@preview?x=1`)).toBe(`/i/${key}.png@full?x=1`);
		expect(fullSrcFromDisplay(`/i/${key}.png@preview#frag`)).toBe(`/i/${key}.png@full#frag`);
	});

	it('passes through @full, bare GIF keys, attachments and external URLs', () => {
		expect(fullSrcFromDisplay(`/i/${key}.png@full`)).toBe(`/i/${key}.png@full`);
		expect(fullSrcFromDisplay(`/i/${key}.gif`)).toBe(`/i/${key}.gif`);
		expect(fullSrcFromDisplay(`/i/${key}.pdf`)).toBe(`/i/${key}.pdf`);
		expect(fullSrcFromDisplay('https://example.com/photo@preview', origin)).toBe(
			'https://example.com/photo@preview'
		);
	});

	it('only rewrites the suffix position (unknown @-words stay literal)', () => {
		expect(fullSrcFromDisplay(`/i/${key}@preview.png`)).toBe(`/i/${key}@preview.png`);
	});

	// DOM reads (`img.src` / `currentSrc`) hand back absolute URLs; the seam
	// that once made the derivation dead on the live path (review 3d P1).
	it('collapses same-origin absolute URLs before deriving', () => {
		expect(fullSrcFromDisplay(`${origin}/i/${key}.png@preview`, origin)).toBe(`/i/${key}.png@full`);
		expect(fullSrcFromDisplay(`${origin}/i/${key}.png@thumb?x=1`, origin)).toBe(
			`/i/${key}.png@full?x=1`
		);
		// Nothing to rewrite: the absolute form survives untouched.
		expect(fullSrcFromDisplay(`${origin}/i/${key}.png@full`, origin)).toBe(
			`${origin}/i/${key}.png@full`
		);
	});

	it('leaves cross-origin absolute URLs and origin-less environments alone', () => {
		expect(fullSrcFromDisplay(`https://cdn.example.com/i/${key}.png@preview`, origin)).toBe(
			`https://cdn.example.com/i/${key}.png@preview`
		);
		expect(fullSrcFromDisplay(`${origin}/i/${key}.png@preview`, null)).toBe(
			`${origin}/i/${key}.png@preview`
		);
	});
});

describe('mimeFromSrc / plainLabel', () => {
	it('detects GIFs from the path, display variants included', () => {
		expect(mimeFromSrc('/i/ab/x.gif')).toBe('image/gif');
		expect(mimeFromSrc('/i/ab/x.gif?x=1')).toBe('image/gif');
		expect(mimeFromSrc('/i/ab/x.gif@preview')).toBe('image/gif');
		expect(mimeFromSrc('/i/ab/x.png@preview')).toBeNull();
	});

	it('prefers alt and falls back to the decoded file name', () => {
		const base = {
			src: '/i/ab/den%20ham.png@preview',
			fullSrc: '/i/ab/den%20ham.png@full',
			alt: '',
			width: null,
			height: null
		};
		expect(plainLabel({ ...base, alt: '  Sunset  ' })).toBe('Sunset');
		expect(plainLabel(base)).toBe('den ham.png');
	});

	it('survives malformed percent-encoding and empty leaves', () => {
		expect(
			plainLabel({
				src: '/i/ab/bad%zz.png@preview',
				fullSrc: '',
				alt: '',
				width: null,
				height: null
			})
		).toBe('bad%zz.png');
		expect(plainLabel({ src: '/i/ab/', fullSrc: '', alt: '', width: null, height: null })).toBe(
			'/i/ab/'
		);
	});
});
