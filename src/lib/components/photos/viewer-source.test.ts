import { describe, expect, it } from 'vitest';
import { fullSrcFromDisplay, mimeFromSrc, plainLabel } from './viewer-source';

/** 3d source adaptation: the @full derivation rule (Q11) and label fallback. */
describe('fullSrcFromDisplay (Q11 lightbox derivation)', () => {
	const key = `ab/ab${'1'.repeat(62)}`;

	it('derives @full from the display variants', () => {
		expect(fullSrcFromDisplay(`/i/${key}.png@preview`)).toBe(`/i/${key}.png@full`);
		expect(fullSrcFromDisplay(`/i/${key}.png@thumb`)).toBe(`/i/${key}.png@full`);
	});

	it('passes through @full, bare GIF keys, attachments and external URLs', () => {
		expect(fullSrcFromDisplay(`/i/${key}.png@full`)).toBe(`/i/${key}.png@full`);
		expect(fullSrcFromDisplay(`/i/${key}.gif`)).toBe(`/i/${key}.gif`);
		expect(fullSrcFromDisplay(`/i/${key}.pdf`)).toBe(`/i/${key}.pdf`);
		expect(fullSrcFromDisplay('https://example.com/photo@preview')).toBe(
			'https://example.com/photo@preview'
		);
	});

	it('only rewrites the suffix position (unknown @-words stay literal)', () => {
		expect(fullSrcFromDisplay(`/i/${key}@preview.png`)).toBe(`/i/${key}@preview.png`);
	});
});

describe('mimeFromSrc / plainLabel', () => {
	it('detects GIFs from the path', () => {
		expect(mimeFromSrc('/i/ab/x.gif')).toBe('image/gif');
		expect(mimeFromSrc('/i/ab/x.gif?x=1')).toBe('image/gif');
		expect(mimeFromSrc('/i/ab/x.png@preview')).toBeNull();
	});

	it('prefers alt and falls back to the decoded file name', () => {
		const base = {
			src: '/i/ab/den%20ham.png@preview',
			fullSrc: '/i/ab/den%20ham.png@full',
			alt: '',
			width: null,
			height: null,
			mimeType: null
		};
		expect(plainLabel({ ...base, alt: '  Sunset  ' })).toBe('Sunset');
		expect(plainLabel(base)).toBe('den ham.png');
	});
});
