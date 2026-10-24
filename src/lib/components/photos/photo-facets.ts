/**
 * Client-safe facet shapes. The server's `PhotoFacets` is structurally
 * assignable to this; keeping the type here avoids importing `$lib/server`
 * from a browser component.
 */
export interface PhotoTagFacet {
	id: string;
	name: string;
	slug: string;
	count?: number;
}

export interface PhotoFacetCounts {
	years: Record<string, number>;
	cameras: Record<string, number>;
	lenses: Record<string, number>;
	tags: Record<string, number>;
}

export interface PhotoFacets {
	years: number[];
	cameras: string[];
	lenses: string[];
	tags: PhotoTagFacet[];
	counts?: PhotoFacetCounts;
}
