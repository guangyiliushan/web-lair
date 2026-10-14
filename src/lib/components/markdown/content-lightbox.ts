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
 * aria-label, keyboard activation and skip rules follow Q14 unchanged. (An
 * independent review re-verified the probe from the specs: box-less
 * elements are not focusable in any current engine, and even once CSSWG
 * lands focusability, a box-less element still cannot draw its own focus
 * ring.)
 *
 * DOM scraping instead of re-parsing the source (Q4 ruling): the enhancement
 * sees exactly what the renderer produced. An image that has not finished
 * loading gets a one-shot `{ once: true }` load listener (a broken image
 * never loads, so it is skipped by construction; the listener removes
 * itself, and a re-render discards the node along with it - the node-level
 * listener precedent from the tabs enhancement, so attach returns nothing,
 * review 3d).
 */
import { m } from '$lib/paraglide/messages';
import { plainImageItem, type PlainImageSource } from '$lib/components/photos/viewer-source';
import { EMBED_MOUNT_CLASS } from '$lib/components/markdown/embed/mount-class';

/** Marker attribute on the enhanced images; doubles as the re-entry guard. */
const CONTENT_LIGHTBOX_ATTR = 'data-content-lightbox';

export function attachContentLightbox(
	article: HTMLElement,
	onOpen: (source: PlainImageSource) => void
): void {
	/** Turns a loaded image into the lightbox control (idempotent). */
	function enhance(img: HTMLImageElement): void {
		img.setAttribute(CONTENT_LIGHTBOX_ATTR, '');
		img.setAttribute('role', 'button');
		img.tabIndex = 0;
		img.classList.add(
			'cursor-zoom-in',
			'focus-visible:ring-2',
			'focus-visible:ring-ring',
			'focus-visible:ring-offset-2',
			// The ring's offset band follows the page background (the dark
			// theme otherwise shows a hard white band); the corner radius
			// comes from the article's own `[&_img]:rounded-lg` - no
			// duplicate class here (review 3d).
			'focus-visible:ring-offset-background',
			// Transparent outline: invisible normally, but forced-colors mode
			// substitutes a system colour, so Windows high-contrast users
			// keep a visible focus indicator (review 3d, a11y).
			'focus-visible:outline-2',
			'focus-visible:outline-offset-2',
			'focus-visible:outline-transparent'
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
		if (img.closest(`a, .${EMBED_MOUNT_CLASS}`)) return; // in-link / embed internals
		if (!img.complete) {
			// Wait for the first successful decode; broken loads never fire
			// `load`, so a broken image is skipped by construction.
			img.addEventListener('load', () => consider(img), { once: true });
			return;
		}
		if (img.naturalWidth === 0) return; // broken: skip (Q14)
		enhance(img);
	}

	for (const img of article.querySelectorAll<HTMLImageElement>('img')) {
		consider(img);
	}
}
