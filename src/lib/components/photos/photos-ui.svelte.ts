import { getContext, setContext } from 'svelte';
import type { PhotoColumns } from '$lib/photos/query';

const KEY = Symbol('photos-ui');

/**
 * Small UI-only store shared by the gallery layout header and the page body.
 * Server-loaded values live in page data; this only carries what the header
 * needs to open (palette), show (count/badges) and reflect (columns).
 */
export class PhotosUi {
	searchOpen = $state(false);
	photoCount = $state<number | null>(null);
	activeFilterCount = $state(0);
	columns = $state<PhotoColumns>('auto');

	openSearch() {
		this.searchOpen = true;
	}
}

export function setPhotosUi(): PhotosUi {
	const ui = new PhotosUi();
	setContext(KEY, ui);
	return ui;
}

export function getPhotosUi(): PhotosUi {
	const ui = getContext<PhotosUi>(KEY);
	if (!ui) throw new Error('PhotosUi context is missing');
	return ui;
}
