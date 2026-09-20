/**
 * The mermaid execution side (spec 3.3 / 7): the pipeline emits
 * `<pre class="mermaid">` mount points on both sides; this upgrades them to
 * SVGs in the browser. Everything here runs client-side only.
 *
 * Design notes:
 * - The library is imported lazily, once per session, only when a diagram
 *   exists on the page (~500 KB gzipped stays out of every other page).
 * - `securityLevel: 'strict'` (mermaid's default, pinned explicitly): labels
 *   are sanitised, no click handlers, no HTML in labels. The hostile-label
 *   case is pinned in the browser spec.
 * - The palette comes from the site's own CSS tokens through `theme: 'base'`
 *   plus an explicit variable map, so diagrams sit in the same colours as the
 *   surrounding content instead of mermaid's stock palette.
 * - mermaid replaces the element's content with the SVG, so the source is
 *   archived on `data-md-source` before the first render; a theme flip
 *   restores it and renders again.
 * - Renders are serialised through one chain: a rebuild (content update) and
 *   a theme flip must not interleave inside mermaid.
 */

let mermaidModule: Promise<typeof import('mermaid').default> | null = null;
let renderChain: Promise<void> = Promise.resolve();

function loadMermaid(): Promise<typeof import('mermaid').default> {
	mermaidModule ??= import('mermaid').then((module) => module.default);
	return mermaidModule;
}

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
 * stores in the tokens. Values the browser cannot parse pass through
 * unchanged (mermaid then degrades on its own terms).
 */
function toSrgb(color: string): string {
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) return color;
	context.fillStyle = '#000000';
	context.fillStyle = color;
	if (context.fillStyle === '#000000' && !/^#?0{3,6}$|^black$/i.test(color.trim())) {
		return color;
	}
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
	if (elements.length === 0) return;
	const mermaid = await loadMermaid();
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: 'strict',
		theme: 'base',
		themeVariables: themeVariables()
	});
	for (const element of elements) {
		const archived = element.getAttribute('data-md-source');
		if (archived !== null) {
			// re-render: restore the source the first render replaced, and
			// drop the marker mermaid leaves behind - `run()` skips elements
			// that already carry `data-processed`, silently
			element.textContent = archived;
			element.removeAttribute('data-processed');
		} else {
			element.setAttribute('data-md-source', element.textContent ?? '');
		}
	}
	await mermaid.run({ nodes: elements, suppressErrors: true });
}

/** Mirrors the mount layer: upgrades every `.mermaid` mount point found. */
export function scheduleMermaidRender(elements: HTMLElement[]): void {
	renderChain = renderChain
		.then(() => renderDiagrams(elements))
		.catch(() => {
			// degrade: the raw source text stays in place (spec 5)
		});
}

/** Re-renders diagrams that already produced an SVG (used on theme flips). */
export function scheduleMermaidRerender(article: Element): void {
	const rendered = [...article.querySelectorAll<HTMLElement>('.mermaid[data-md-source]')];
	if (rendered.length === 0) return;
	scheduleMermaidRender(rendered);
}
