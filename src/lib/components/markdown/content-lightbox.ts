/**
 * Content lightbox (ST-3 3d, Q4/Q14): progressive enhancement of article
 * images. Every rendered `<img>` inside the article (except images inside
 * links, embed-card internals and broken images - `naturalWidth == 0`)
 * becomes an interactive control whose localised aria-label is
 * "view larger: {alt}"; activating it (click / Enter / Space) opens the
 * shared overlay viewer with a plain-image source (Q11: the `@full` frame
 * derives from the displayed variant). SSR and no-JS are untouched: the
 * attributes only exist after the client enhancement runs, so the static
 * output stays a plain image.
 *
 * Technique deviation (probed, 2026-10-13): the Q14 sketch said "wrap in a
 * `display:contents` button". A probe showed `display:contents` elements
 * cannot receive focus (no box => not in the tab order; `focus()` is a
 * no-op), which would break keyboard access AND the ruling's own
 * focus-return tooth; an inline-box wrapper is focusable but perturbs
 * layout (tailwind preflight makes prose images `display:block`, and a
 * block image inside an inline wrapper collapses the line box: 78px -> 37px
 * in the probe). Carrying `role="button"` + `tabindex` on the image itself
 * is the only formulation that is BOTH layout-neutral and focusable; the
 * aria-label, keyboard activation and skip rules follow Q14 unchanged.
 *
 * DOM scraping instead of re-parsing the source (Q4 ruling): the enhancement
 * sees exactly what the renderer produced. Images that have not finished
 * loading get a one-shot `load` listener (a broken image never loads, so it
 * is skipped by construction).
 */
import { m } from '$lib/paraglide/messages';
import { plainImageItem, type PlainImageSource } from '$lib/components/photos/viewer-source';

/** Marker attribute on the enhanced images; doubles as the re-entry guard. */
export const CONTENT_LIGHTBOX_ATTR = 'data-content-lightbox';

export function attachContentLightbox(
	article: HTMLElement,
	onOpen: (source: PlainImageSource) => void
): () => void {
	const cleanups: Array<() => void> = [];

	/** Turns a loaded image into the lightbox control (idempotent). */
	function enhance(img: HTMLImageElement): void {
		img.setAttribute(CONTENT_LIGHTBOX_ATTR, '');
		img.setAttribute('role', 'button');
		img.tabIndex = 0;
		img.classList.add(
			'cursor-zoom-in',
			'rounded-lg',
			'focus-visible:ring-2',
			'focus-visible:ring-ring',
			'focus-visible:ring-offset-2',
			'focus-visible:outline-none'
		);
		const alt = (img.getAttribute('alt') ?? '').trim();
		img.setAttribute(
			'aria-label',
			alt ? m.photos_viewer_open_alt({ alt: alt }) : m.photos_viewer_open()
		);
		img.addEventListener('click', () => onOpen(plainImageItem(img)));
		img.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				onOpen(plainImageItem(img));
			}
		});
	}

	function consider(img: HTMLImageElement): void {
		if (img.hasAttribute(CONTENT_LIGHTBOX_ATTR)) return; // already enhanced
		if (img.closest('a')) return; // in-link images keep the link behavior
		if (img.closest('.embed-card-mount')) return; // embed internals untouched
		if (img.complete && img.naturalWidth === 0) return; // broken: skip (Q14)
		if (!img.complete) {
			// Wait for the first successful decode; broken loads never fire.
			const onLoad = () => {
				img.removeEventListener('load', onLoad);
				if (img.naturalWidth > 0) enhance(img);
			};
			img.addEventListener('load', onLoad);
			cleanups.push(() => img.removeEventListener('load', onLoad));
			return;
		}
		enhance(img);
	}

	for (const img of article.querySelectorAll<HTMLImageElement>('img')) {
		consider(img);
	}

	return () => {
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;
	};
}
