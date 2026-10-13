import { describe, expect, it } from 'vitest';
import { EMBED_PREVIEW_LONG_EDGE, photoEmbedSrc, photoTileSrc } from './photo-tile';
import { PREVIEW_BOX } from '$lib/server/media/variants';

/**
 * The embed tier must track the pipeline's object-existence rule: `@preview`
 * exists only above the preview box (review round 1 welded the two sides).
 */
const KEY = 'ab/ab' + 'a'.repeat(62) + '.png';
const GIF_KEY = 'ab/ab' + 'a'.repeat(62) + '.gif';

describe('photoEmbedSrc - the body-image tier (Q11, review round 1)', () => {
	it('welds the mirrored preview box to the pipeline constant', () => {
		expect(EMBED_PREVIEW_LONG_EDGE).toBe(PREVIEW_BOX);
	});

	it('takes the bare key for GIFs (their own public tier)', () => {
		expect(
			photoEmbedSrc({ mimeType: 'image/gif', objectKey: GIF_KEY, width: 10, height: 10 })
		).toBe(`/i/${GIF_KEY}`);
	});

	it('embeds @preview only above the preview box', () => {
		expect(photoEmbedSrc({ mimeType: 'image/png', objectKey: KEY, width: 2561, height: 100 })).toBe(
			`/i/${KEY}@preview`
		);
	});

	it('falls back to @full at the box and for unknown dimensions', () => {
		expect(
			photoEmbedSrc({ mimeType: 'image/png', objectKey: KEY, width: 2560, height: 1440 })
		).toBe(`/i/${KEY}@full`);
		expect(
			photoEmbedSrc({ mimeType: 'image/png', objectKey: KEY, width: null, height: null })
		).toBe(`/i/${KEY}@full`);
	});

	it('takes the bare key for non-image attachments (defensive)', () => {
		const pdfKey = 'ab/ab' + 'a'.repeat(62) + '.pdf';
		expect(
			photoEmbedSrc({ mimeType: 'application/pdf', objectKey: pdfKey, width: null, height: null })
		).toBe(`/i/${pdfKey}`);
	});

	it('keeps the tile tiers unchanged (thumb still the 480 box)', () => {
		expect(photoTileSrc({ mimeType: 'image/png', objectKey: KEY }, 'thumb')).toBe(
			`/i/${KEY}@thumb`
		);
	});
});
