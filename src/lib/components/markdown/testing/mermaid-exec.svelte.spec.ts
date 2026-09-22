import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MarkdownRenderer from '$lib/components/markdown/editor/MarkdownRenderer.svelte';
import { themeStore } from '$lib/stores/theme.svelte';

import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

// Browser-project spec: the mermaid execution side (spec 3.3 / 7).
//
// The oracle matters here: mermaid appends scaffolding (`.mermaid > div >
// svg`) before it commits the final svg (`.mermaid > svg`), so polling for
// "an svg exists" reads half-rendered states - earlier assertions were
// falsely green through exactly that. Every readiness check below anchors on
// the settled shape: a direct svg child of the mount point.
const SVG = '.mermaid > svg';
const settled = (container: Element) => container.querySelector<SVGElement>(SVG);
const resourceCount = (pattern: RegExp) =>
	performance.getEntriesByType('resource').filter((entry) => pattern.test(entry.name)).length;
// vite serves the lazy chunk from /node_modules/.vite/deps/; the spec's own
// module path also contains "mermaid", so match the deps directory alone
const CHUNK = /[/]deps[/]mermaid|mermaid[.]core|mermaid@/;
const BEACON = /127\.0\.0\.1:9/;

/** The token colour as the implementation resolves it (canvas pixels). */
function tokenFill(name: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) return value;
	context.fillStyle = value;
	context.fillRect(0, 0, 1, 1);
	const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
	return `rgb(${r}, ${g}, ${b})`;
}

const fence = (body: string) => '```mermaid\n' + body + '\n```';
const MERMAID = fence('graph TD;\n  A[甲] --> B[乙];');
const HOSTILE = fence('graph TD;\n  A["<img src=//127.0.0.1:9/beacon.png>"] --> B[ok];');
const CLICK = fence('graph TD;\n  A[a] --> B;\n  click A "javascript:window.__x=1";');
const DIRECTIVE = fence(
	'%%{init: {"htmlLabels": true, "securityLevel": "loose"}}%%\ngraph TD;\n  A[x] --> B;'
);
const IMAGE_SHAPE = fence('graph LR;\n  A@{ img: "//127.0.0.1:9/shape.png", label: "i" } --> B;');
const FRONTMATTER_HTML = fence(
	'---\nconfig:\n  htmlLabels: true\n---\ngraph TD;\n  A["<img src=//127.0.0.1:9/fm.png>"] --> B[ok];'
);
const FRONTMATTER_CSS = fence(
	'---\nconfig:\n  themeCSS: "#zz-frontmatter-css { fill: rgb(1,2,3) }"\n---\ngraph TD;\n  A[x] --> B;'
);
// The six frontmatter shapes an independent re-review measured as leaking
// past the first closure (fo=2/img=1/beacon=2): indented block,
// directive-prefixed (newline and glued), and 0x0C/0x0B at the opener or
// closer. All must strip to the same closed state.
// chained blocks: the strip must reach a TRUE fixpoint - mermaid itself
// extracts one frontmatter block, so a capped loop of N leaks the N+1th
const chained = (blocks: number, name: string) =>
	'---\nconfig:\n  htmlLabels: true\n---\n'.repeat(blocks) +
	'graph TD;\n  A["<img src=//127.0.0.1:9/' +
	name +
	'>"] --> B;';

const LEAKY_SHAPES = [
	fence(
		'  ---\n  config:\n    htmlLabels: true\n  ---\n  graph TD;\n  A["<img src=//127.0.0.1:9/ind.png>"] --> B;'
	),
	fence(
		'%%{init: {"theme":"base"}}%%\n---\nconfig:\n  htmlLabels: true\n---\ngraph TD;\n  A["<img src=//127.0.0.1:9/nl.png>"] --> B;'
	),
	fence(
		'%%{init: {"theme":"base"}}%%---\nconfig:\n  htmlLabels: true\n---\ngraph TD;\n  A["<img src=//127.0.0.1:9/glued.png>"] --> B;'
	),
	fence(
		'---\u000C\nconfig:\n  htmlLabels: true\n---\ngraph TD;\n  A["<img src=//127.0.0.1:9/ff.png>"] --> B;'
	),
	fence(
		'---\u000B\nconfig:\n  htmlLabels: true\n---\ngraph TD;\n  A["<img src=//127.0.0.1:9/vt.png>"] --> B;'
	),
	fence(
		'---\nconfig:\n  htmlLabels: true\n---\u000C\ngraph TD;\n  A["<img src=//127.0.0.1:9/cff.png>"] --> B;'
	),
	fence(chained(7, 'chain.png')),
	fence('%%{init: {"theme":"base"}}%%\n' + chained(6, 'dchain.png'))
];
const BROKEN = fence('graph TD;\n  A[oops --> ;');

async function mountRenderer(source: string) {
	await page.viewport(1000, 800);
	return render(MarkdownRenderer, { source });
}

const waitForSettled = (container: Element) =>
	expect.poll(() => settled(container) !== null, { timeout: 30_000 }).toBe(true);

afterEach(() => {
	themeStore.value = 'light';
	document.documentElement.classList.remove('dark');
	localStorage.removeItem('theme');
});

describe('mermaid execution (client)', () => {
	it(
		'renders lazily: no diagram, no chunk; the chunk is loaded once',
		{ timeout: 60_000 },
		async () => {
			const before = resourceCount(CHUNK);
			const plain = await mountRenderer('just text, no diagram');
			expect(plain.container.querySelector('.mermaid')).toBeNull();
			// a bounded wait, not a poll: a poll cannot prove a negative, and an
			// import that was going to happen lands in resource timing within a
			// couple of frames
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(resourceCount(CHUNK) - before).toBe(0);

			const first = await mountRenderer(MERMAID);
			await waitForSettled(first.container);
			const afterFirst = resourceCount(CHUNK);
			expect(afterFirst - before).toBeGreaterThan(0);

			const second = await mountRenderer(MERMAID);
			await waitForSettled(second.container);
			expect(resourceCount(CHUNK) - afterFirst).toBe(0);
		}
	);

	it('archives the exact source for re-rendering', async () => {
		const screen = await mountRenderer(MERMAID);
		await waitForSettled(screen.container);
		const archived = screen.container.querySelector('.mermaid')?.getAttribute('data-md-source');
		// unique markers, not the shared "graph TD" prefix: an archive that
		// got truncated or replaced by a constant must fail here
		expect(archived).toContain('A[甲] --> B[乙]');
		expect(archived).toContain('\n');
	});

	it('keeps hostile labels inert and ignores per-diagram directives', async () => {
		const beacons = resourceCount(BEACON);
		const hostile = await mountRenderer(HOSTILE);
		await waitForSettled(hostile.container);
		const svg = settled(hostile.container)!;
		expect(svg.querySelector('img, image, script, foreignObject')).toBeNull();
		for (const node of svg.querySelectorAll('*')) {
			for (const attribute of node.attributes) {
				expect(attribute.name.toLowerCase().startsWith('on')).toBe(false);
			}
		}
		expect(resourceCount(BEACON) - beacons).toBe(0);

		// the strict/loose discriminator: only loose binds the click handler
		const click = await mountRenderer(CLICK);
		await waitForSettled(click.container);
		const anchors = [...settled(click.container)!.querySelectorAll('a')];
		// the anchor must exist, otherwise the href checks below are vacuous
		expect(anchors.length).toBeGreaterThan(0);
		for (const anchor of anchors) {
			expect(anchor.getAttribute('href') ?? '').not.toContain('javascript:');
			expect(anchor.getAttribute('xlink:href') ?? '').not.toContain('javascript:');
		}

		// a diagram cannot flip htmlLabels back on via its own directive
		const directive = await mountRenderer(DIRECTIVE);
		await waitForSettled(directive.container);
		expect(settled(directive.container)!.querySelector('foreignObject')).toBeNull();

		// the second config channel: YAML frontmatter `config:` - mermaid
		// deprecated directives in favour of it, so both must be stripped
		const fmBeacons = resourceCount(BEACON);
		const frontmatter = await mountRenderer(FRONTMATTER_HTML);
		await waitForSettled(frontmatter.container);
		expect(
			settled(frontmatter.container)!.querySelector('img, image, script, foreignObject')
		).toBeNull();
		expect(resourceCount(BEACON) - fmBeacons).toBe(0);

		const css = await mountRenderer(FRONTMATTER_CSS);
		await waitForSettled(css.container);
		// scoped to this mount: mermaid injects themeCSS into the svg itself
		expect(
			[...css.container.querySelectorAll('style')].some((node) =>
				(node.textContent ?? '').includes('zz-frontmatter-css')
			)
		).toBe(false);
	});

	it('strips the config channels in every shape the re-review measured open', async () => {
		for (const [index, shape] of LEAKY_SHAPES.entries()) {
			const beacons = resourceCount(BEACON);
			const screen = await mountRenderer(shape);
			await expect
				.poll(() => settled(screen.container) !== null, {
					timeout: 30_000,
					message: `shape ${index}`
				})
				.toBe(true);
			expect(
				settled(screen.container)!.querySelector('img, image, script, foreignObject'),
				`shape ${index}`
			).toBeNull();
			expect(resourceCount(BEACON) - beacons, `shape ${index}`).toBe(0);
		}
	});

	it('re-renders with the token palette when the theme flips', async () => {
		const screen = await mountRenderer(MERMAID);
		await waitForSettled(screen.container);
		const fillOf = () => {
			const shape = settled(screen.container)?.querySelector(
				'.node rect, .node circle, .node polygon'
			);
			return shape ? getComputedStyle(shape).fill : '';
		};
		expect(fillOf()).toBe(tokenFill('--muted'));
		themeStore.init();
		themeStore.value = 'dark';
		await expect
			.poll(() => document.documentElement.classList.contains('dark'), { timeout: 30_000 })
			.toBe(true);
		const darkToken = tokenFill('--muted');
		expect(darkToken).not.toBe(fillOf());
		await expect.poll(() => fillOf(), { timeout: 30_000 }).toBe(darkToken);
	});

	it('rolls failed diagrams back to their raw source', async () => {
		const broken = await mountRenderer(BROKEN);
		await expect
			.poll(() => broken.container.querySelector('.mermaid[data-md-error]') !== null, {
				timeout: 30_000
			})
			.toBe(true);
		expect(settled(broken.container)).toBeNull();
		expect(broken.container.querySelector('.mermaid')?.textContent).toContain('A[oops -->');

		const beacons = resourceCount(BEACON);
		const shape = await mountRenderer(IMAGE_SHAPE);
		await expect
			.poll(() => shape.container.querySelector('.mermaid[data-md-error="image-shape"]') !== null, {
				timeout: 30_000
			})
			.toBe(true);
		expect(shape.container.querySelector('.mermaid')?.textContent).toContain('@{');
		expect(resourceCount(BEACON) - beacons).toBe(0);
	});

	it('survives rapid theme flips and content swaps', async () => {
		const screen = await mountRenderer(MERMAID);
		await waitForSettled(screen.container);
		themeStore.init();
		themeStore.value = 'dark';
		themeStore.value = 'light';
		const second = await mountRenderer(fence('graph TD;\n  A[丙] --> B[丁];'));
		await expect
			.poll(() => settled(second.container)?.textContent?.includes('丙') === true, {
				timeout: 30_000
			})
			.toBe(true);
		expect(settled(screen.container)).not.toBeNull();
		expect(screen.container.querySelectorAll('.mermaid')).toHaveLength(1);
	});
});
