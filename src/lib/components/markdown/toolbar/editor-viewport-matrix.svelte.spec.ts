import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ToolbarTestHost from './ToolbarTestHost.svelte';

/**
 * Layout invariants across a representative device-viewport matrix.
 *
 * Devices are equivalence classes: within one responsive breakpoint the
 * layout code path is identical, so one representative per class plus every
 * breakpoint boundary and special form factor (foldable inner/outer, tiny
 * landscape phones, ultrawide) is sufficient. Sources: webmobilefirst.com
 * device tables and foldable viewport reports (Z Fold 5 inner 806x771,
 * Pixel Fold inner 692x717).
 */
const VIEWPORT_MATRIX: Array<{ w: number; h: number; label: string }> = [
	{ w: 320, h: 568, label: 'smallest phone (iPhone SE 1st)' },
	{ w: 360, h: 780, label: 'most common Android (Galaxy S24)' },
	{ w: 412, h: 915, label: 'wide Android (Pixel 10)' },
	{ w: 425, h: 700, label: 'large phone portrait' },
	{ w: 640, h: 960, label: 'tailwind sm boundary' },
	{ w: 692, h: 717, label: 'Pixel Fold inner (wide + short)' },
	{ w: 768, h: 1024, label: 'md boundary / iPad Mini' },
	{ w: 806, h: 771, label: 'Z Fold 5 inner (wide + short)' },
	{ w: 834, h: 1194, label: 'iPad Pro 11 portrait' },
	{ w: 900, h: 780, label: 'toolbar tier boundary 900' },
	{ w: 844, h: 390, label: 'phone landscape (very short)' },
	{ w: 1024, h: 768, label: 'lg boundary / sidebar expands' },
	{ w: 1180, h: 820, label: 'iPad landscape (lg, short)' },
	{ w: 1280, h: 800, label: 'xl boundary / MacBook Air' },
	{ w: 1536, h: 960, label: '2xl boundary' },
	{ w: 1920, h: 1080, label: 'common desktop' },
	{ w: 2560, h: 1200, label: 'ultrawide desktop' }
];

// Minimum editor height fallback (min-h-48 = 192px in MarkdownEditor chain).
const MIN_EDITOR_H = 192;

describe('editor viewport matrix', () => {
	for (const { w, h, label } of VIEWPORT_MATRIX) {
		it(`layout holds at ${w}x${h} (${label})`, async () => {
			await page.viewport(w, h);
			await render(ToolbarTestHost, { initialMarkdown: '', placeholder: '输入正文...' });

			const ed = page.getByRole('textbox', { name: '输入正文...' });
			await expect.element(ed).toBeInTheDocument();

			const m = await (async () => {
				const el = await ed.element();
				const de = document.documentElement;
				const r = el.getBoundingClientRect();
				const toolbar = document.querySelector('[role="toolbar"][aria-label="编辑器工具栏"]');
				const tr = toolbar?.getBoundingClientRect();
				return {
					hOverflow: de.scrollWidth > de.clientWidth + 1,
					vScroll: de.scrollHeight > de.clientHeight + 1,
					editorTop: Math.round(r.top),
					editorH: Math.round(r.height),
					editorW: Math.round(r.width),
					viewportW: de.clientWidth,
					toolbarVisible: !!tr && tr.width > 0 && tr.height > 0
				};
			})();

			// Invariant 1: the page never scrolls horizontally.
			expect(m.hOverflow, `horizontal overflow at ${w}x${h}`).toBe(false);
			// Invariant 2: the editor mounts at fallback height or fills the space.
			expect(m.editorH).toBeGreaterThanOrEqual(MIN_EDITOR_H);
			// Invariant 3: vertical scroll when empty is only allowed when even
			// the fallback editor (192px) cannot fit above the fold.
			const fallbackCannotFit = m.editorTop + MIN_EDITOR_H > h;
			expect(m.vScroll, `unexpected vertical scroll at ${w}x${h}`).toBe(fallbackCannotFit);
			// Invariant 4: the editor stays inside the viewport horizontally.
			expect(m.editorW).toBeLessThanOrEqual(m.viewportW);
			// Invariant 5: the toolbar renders.
			expect(m.toolbarVisible).toBe(true);
		});
	}
});
