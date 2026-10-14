/**
 * Source adaptation layer (ST-3 3d, Q4): the overlay viewer consumes one
 * normalized set of per-item questions. The photo-feed side keeps its
 * `PhotoViewerSource` records (the overlay walks them via neighbours); the
 * content side adapts a plain article `<img>` - displayed frame, derived
 * `@full` target (Q11: `/i/<key>@preview|@thumb` -> same key `@full`; GIF
 * bare keys and external URLs pass through), alt label and natural size.
 */

export interface PlainImageSource {
	/** As displayed by the article (also the pre-load frame). */
	src: string;
	/** Streamed "full" target; equals `src` when there is nothing to upgrade. */
	fullSrc: string;
	alt: string;
	width: number | null;
	height: number | null;
}

/**
 * `/i/<key>@thumb` / `/i/<key>@preview` -> `/i/<key>@full` (Q11). DOM reads
 * (`img.src` / `currentSrc`) always hand back absolute URLs, so same-origin
 * absolute forms are collapsed to their path first (3d review P1: the
 * literal-prefix guard alone never matched real DOM input, and the upgrade
 * silently never fired). Everything else passes through unchanged: `@full`
 * itself, GIF bare keys, attachment keys and external URLs. `origin` is
 * injectable for tests; the browser default reads `location.origin`.
 */
export function fullSrcFromDisplay(
	src: string,
	origin: string | null = typeof location !== 'undefined' ? location.origin : null
): string {
	let path = src;
	if (/^https?:\/\//i.test(src)) {
		if (origin === null) return src; // no page origin to compare against
		try {
			const url = new URL(src);
			if (url.origin !== origin) return src; // cross-origin: pass through
			path = url.pathname + url.search + url.hash;
		} catch {
			return src;
		}
	}
	if (!path.startsWith('/i/')) return src;
	const rewritten = path.replace(/@(?:thumb|preview)(?=$|[?#])/, '@full');
	return rewritten === path ? src : rewritten;
}

/**
 * GIF detection from the URL alone, display-variant suffix included (plain
 * items keep GIFs single-layer, mirroring the feed's `photoTileSrc` GIF
 * case: the displayed file IS the full image, so no `@full` target is
 * derived - and a legacy `@preview` GIF key never pumps a doomed fetch).
 */
export function mimeFromSrc(src: string): string | null {
	const path = (src.split(/[?#]/)[0] ?? '').replace(/@(?:thumb|preview|full)$/, '');
	return /\.gif$/i.test(path) ? 'image/gif' : null;
}

/** Adapts an article `<img>` into the viewer's plain source (3d). */
export function plainImageItem(img: HTMLImageElement): PlainImageSource {
	const src = img.currentSrc || img.src;
	const fullSrc = mimeFromSrc(src) === 'image/gif' ? src : fullSrcFromDisplay(src);
	return {
		src,
		fullSrc,
		alt: img.alt ?? '',
		width: img.naturalWidth > 0 ? img.naturalWidth : null,
		height: img.naturalHeight > 0 ? img.naturalHeight : null
	};
}

/** Caption/title for a plain source: alt, else the file name from the URL. */
export function plainLabel(source: PlainImageSource): string {
	const alt = source.alt.trim();
	if (alt) return alt;
	const leaf = (source.src.split(/[?#]/)[0]?.split('/').pop() ?? '').replace(
		/@(?:thumb|preview|full)$/,
		''
	);
	try {
		return decodeURIComponent(leaf) || source.src;
	} catch {
		return leaf || source.src;
	}
}
