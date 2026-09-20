/**
 * The mermaid execution side (spec 3.3 / 7): the pipeline emits
 * `<pre class="mermaid">` mount points on both sides; this upgrades them to
 * SVGs in the browser. Everything here runs client-side only.
 *
 * Design notes:
 * - The library is imported lazily, only when a diagram exists on the page -
 *   pages without diagrams never pay for the chunk.
 * - Content is untrusted (spec 6). `securityLevel: 'strict'` is pinned, but
 *   on mermaid 12 the name overstates it: it strips event handlers and click
 *   callbacks while DOMPurify's default allowlist still keeps elements like
 *   `img` inside html labels - and a kept `img` issues a real request. Three
 *   layers close the surface instead:
 *   1. `htmlLabels: false` renders labels as SVG `text` - no foreignObject
 *      for ordinary diagrams;
 *   2. `%%{init: ...}%%` directives are stripped from the source before
 *      rendering, so a diagram cannot flip `htmlLabels` back on or inject
 *      `themeCSS` (directives are per-diagram config, not content);
 *   3. sources carrying `@{ img: ... }` node syntax are not rendered at all:
 *      that shape loads a remote image while rendering, which would bypass
 *      the spec's "images only through `!`" rule (4.5).
 * - The palette comes from the site's own CSS tokens through `theme: 'base'`
 *   plus an explicit variable map, so diagrams sit in the same colours as
 *   the surrounding content instead of mermaid's stock palette.
 * - mermaid replaces the element's content with the SVG, so the source is
 *   archived on `data-md-source` before the first render; a theme flip
 *   restores it and renders again.
 * - After a run every element is checked for the settled shape (exactly one
 *   svg child, no mermaid error svg); anything else rolls back to the raw
 *   source with a `data-md-error` mark instead of mermaid's scaffolding.
 * - Renders are serialised through one chain: a rebuild (content update) and
 *   a theme flip must not interleave inside mermaid.
 */

let renderChain: Promise<void> = Promise.resolve();

/** `%%{ init: ... }%%` is a single line; inner braces are allowed. */
const DIRECTIVE = /%%\{[\s\S]*?\}%%/g;
/** The v11+ node syntax that fetches a remote image while rendering. */
const IMAGE_SHAPE = /@\{[^}]*\bimg\s*:/;

/**
 * The theme contract is the shadcn-svelte one: semantic tokens declared in
 * `layout.css` (`:root` / `.dark`, oklch() values, swappable wholesale), and
 * the spec's own rule is "semantic colours, never raw values" - so the
 * diagram palette is read from those tokens at render time and follows any
 * theme swap for free.
 *
 * mermaid's colour parser (khroma) cannot read oklch(), and it throws on it.
 * Neither getComputedStyle nor the canvas fillStyle getter normalises the
 * format, so the conversion goes through actual pixels: fill a 1x1 canvas
 * and read the bytes back - format-agnostic for whatever a future theme
 * stores in the tokens. A value the browser rejects is handed on unchanged
 * (mermaid then degrades on its own terms).
 */
function toSrgb(value: string): string {
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) return value;
	const before = context.fillStyle;
	context.fillStyle = value;
	if (context.fillStyle === before) return value;
	context.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
	if (a === 0) return 'transparent';
	if (a === 255) {
		return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
	}
	return `rgba(${r},${g},${b},${Number((a / 255).toFixed(3))})`;
}

/** The site's tokens, mapped onto mermaid's base-theme variables. */
function themeVariables(): Record<string, string> {
	const styles = getComputedStyle(document.documentElement);
	const token = (name: string, fallback: string) =>
		toSrgb(styles.getPropertyValue(name).trim() || fallback);
	const bodyFont = getComputedStyle(document.body).fontFamily;
	return {
		background: 'transparent',
		fontFamily: bodyFont || 'inherit',
		primaryColor: token('--muted', '#f5f5f5'),
		primaryTextColor: token('--foreground', '#111111'),
		primaryBorderColor: token('--border', '#dddddd'),
		secondaryColor: token('--muted', '#f5f5f5'),
		tertiaryColor: token('--card', 'transparent'),
		lineColor: token('--border', '#999999'),
		textColor: token('--foreground', '#111111'),
		edgeLabelBackground: token('--background', '#ffffff')
	};
}

async function renderDiagrams(elements: HTMLElement[]): Promise<void> {
	// nodes detached by a newer render ({@html} swapped the article) are not
	// worth rendering; the last batch always carries the live nodes
	const live = elements.filter((element) => element.isConnected);
	if (live.length === 0) return;
	const mermaid = (await import('mermaid')).default;
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: 'strict',
		htmlLabels: false,
		logLevel: 'error',
		theme: 'base',
		themeVariables: themeVariables()
	});
	for (const element of live) {
		// clear the marker mermaid leaves behind: `run()` skips elements
		// that already carry `data-processed`, silently
		element.removeAttribute('data-processed');
		const source = element.getAttribute('data-md-source') ?? element.textContent ?? '';
		if (element.getAttribute('data-md-source') === null) {
			element.setAttribute('data-md-source', source);
		}
		if (IMAGE_SHAPE.test(source)) {
			element.textContent = source;
			element.setAttribute('data-md-error', 'image-shape');
			continue;
		}
		element.textContent = source.replace(DIRECTIVE, '');
	}
	const runnable = live.filter((element) => !element.hasAttribute('data-md-error'));
	if (runnable.length === 0) return;
	await mermaid.run({ nodes: runnable, suppressErrors: true });
	// the settled shape is exactly one svg child; anything else (scaffolding
	// left by a failed render, or mermaid's error svg) rolls back to the raw
	// source so "degrade to the raw text" is true rather than aspirational
	for (const element of runnable) {
		if (element.hasAttribute('data-md-error')) continue;
		const settled =
			element.children.length === 1 &&
			element.firstElementChild?.tagName.toLowerCase() === 'svg' &&
			element.querySelector('[aria-roledescription="error"]') === null;
		if (!settled) {
			element.textContent = element.getAttribute('data-md-source') ?? '';
			element.removeAttribute('data-processed');
			element.setAttribute('data-md-error', 'render');
			console.warn('[markdown] mermaid diagram failed - raw source kept (spec 5)');
		}
	}
}

/** Mirrors the mount layer: upgrades every `.mermaid` mount point found. */
export function scheduleMermaidRender(elements: HTMLElement[]): void {
	renderChain = renderChain
		.then(() => renderDiagrams(elements))
		.catch((error) => {
			console.warn('[markdown] mermaid render failed', error);
		});
}
