import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { ViewerImageSource } from './viewer-load';
import PhotosViewerImage from './photos-viewer-image.svelte';

/**
 * Round-3 review, P2: SSR cannot see `navigator.connection`, so a GIF must
 * never render an <img> server-side — otherwise a metered client preloads
 * the original before hydration and the two renders disagree on the branch.
 */
function source(overrides: Record<string, unknown>): ViewerImageSource {
	return {
		id: 'p1',
		slug: 'sunset',
		title: null,
		description: null,
		takenAt: null,
		createdAt: null,
		cameraMake: null,
		cameraModel: null,
		lensModel: null,
		fNumber: null,
		focalLengthMm: null,
		exposureTimeS: null,
		iso: null,
		latitude: null,
		longitude: null,
		altitudeM: null,
		objectKey: 'aa/x.gif',
		fileName: 'x.gif',
		mimeType: 'image/gif',
		byteSize: 10,
		width: 4,
		height: 4,
		thumbhash: null,
		palette: null,
		...overrides
	} as unknown as ViewerImageSource;
}

describe('photos-viewer-image SSR (GIFs defer the <img> to the client)', () => {
	it('renders NO <img> for a GIF', () => {
		const { body } = render(PhotosViewerImage, {
			props: { photo: source({}), alt: 'still' }
		});
		expect(body).not.toContain('<img');
	});

	it('renders the thumb <img> for a regular photo', () => {
		const { body } = render(PhotosViewerImage, {
			props: { photo: source({ mimeType: 'image/jpeg', objectKey: 'aa/x.jpg' }), alt: 'still' }
		});
		expect(body).toContain('<img');
		expect(body).toContain('@thumb');
	});
});
