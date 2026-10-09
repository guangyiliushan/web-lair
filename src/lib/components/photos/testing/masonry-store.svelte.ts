import type { PhotoTile } from '../photo-tile';

/**
 * Test-only reactive store: `$state` requires a `.svelte.ts` module, and
 * mutating the SAME proxy in place is what lets the mounted grid observe an
 * append (the component keeps its prop identity).
 */
export function masonryStore(initial: PhotoTile[]) {
	const items = $state<PhotoTile[]>([...initial]);
	return {
		get items(): PhotoTile[] {
			return items;
		},
		append(extra: PhotoTile[]): void {
			items.push(...extra);
		},
		replace(next: PhotoTile[]): void {
			items.length = 0;
			items.push(...next);
		}
	};
}
