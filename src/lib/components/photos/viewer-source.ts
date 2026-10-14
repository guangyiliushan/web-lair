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
	mimeType: string | null;
}

/**
 * `/i/<key>@thumb` / `/i/<key>@preview` -> `/i/<key>@full` (Q11). Everything
 * else passes through unchanged: `@full` itself, GIF bare keys, attachment
 * keys and external URLs.
 */
export function fullSrcFromDisplay(src: string): string {
	if (!src.startsWith('/i/')) return src;
	return src.replace(/@(?:thumb|preview)(?=$|[?#])/, '@full');
}

/** GIF detection from the URL alone (the overlay's interim rule needs it). */
export function mimeFromSrc(src: string): string | null {
	const path = src.split(/[?#]/)[0] ?? '';
	return /\.gif$/i.test(path) ? 'image/gif' : null;
}

/** Adapts an article `<img>` into the viewer's plain source (3d). */
export function plainImageItem(img: HTMLImageElement): PlainImageSource {
	const src = img.currentSrc || img.src;
	return {
		src,
		fullSrc: fullSrcFromDisplay(src),
		alt: img.alt ?? '',
		width: img.naturalWidth > 0 ? img.naturalWidth : null,
		height: img.naturalHeight > 0 ? img.naturalHeight : null,
		mimeType: mimeFromSrc(src)
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
