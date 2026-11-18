// attachContentLightbox progressively enhances every rendered article image into a
// button-role control: images inside links, embed-card internals and broken images
// (`naturalWidth == 0`) are skipped, the rest get a localised aria-label and open the
// shared overlay viewer on click / Enter / Space with a plain-image source whose
// `@full` target derives from the displayed variant.
// SSR and no-JS are untouched — the attributes only exist after the client enhancement
// runs, and the pass walks the DOM the renderer produced instead of re-parsing the
// source.
// The image itself carries the control: a `display:contents` wrapper cannot receive
// focus and an inline wrapper collapses the block image's line box, so no wrapper is
// both layout-neutral and focusable.
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
			// comes the corner radius from the article's own `[&_img]:rounded-lg`
			// - no duplicate class here.
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
		if (img.naturalWidth === 0) return; // broken: skip
		enhance(img);
	}

	for (const img of article.querySelectorAll<HTMLImageElement>('img')) {
		consider(img);
	}
}
