import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import PhotosMasonry from './photos-masonry.svelte';
import type { PhotoTile } from './photo-tile';

/** SSR first paint (§5.1 POC item): every tile link is in the server HTML. */
const tile = (index: number): PhotoTile => ({
	id: `ssr-${index}`,
	slug: `ssr-${index}`,
	title: null,
	description: null,
	takenAt: null,
	cameraMake: null,
	cameraModel: null,
	lensModel: null,
	objectKey: `aa/${'a'.repeat(60)}${index}.jpg`,
	fileName: `ssr-${index}.jpg`,
	mimeType: 'image/jpeg',
	width: 4000,
	height: 3000,
	thumbhash: null
});

describe('photos masonry SSR', () => {
	it('renders every tile link server-side (no JS required)', () => {
		const items = [tile(1), tile(2), tile(3)];
		const { body } = render(PhotosMasonry, { props: { items } });
		for (const item of items) {
			expect(body).toContain(`/photos/${item.slug}`);
		}
		expect(body.match(/<a /g)?.length ?? 0).toBe(3);
	});
});
