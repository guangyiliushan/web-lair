import { page, userEvent } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
// Pin the UI locale inside the browser iframe (node-side setup cannot reach it).
overwriteGetLocale(() => 'zh-cn');

import MarkdownRenderer from '../editor/MarkdownRenderer.svelte';

/**
 * Content lightbox (3d) integration: the enhancement wraps article images in
 * `display:contents` buttons (localised aria label), leaves in-link images
 * and broken images alone, and clicking a wrapper opens the shared overlay
 * viewer which closes on Esc with focus handed back to the wrapper. The
 * sources are self-contained SVG data URLs - they decode immediately (no
 * network) and pass through the adapter untouched.
 */
const svg = (width: number, height: number, fill: string) =>
	`data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'%3E%3Crect width='100%25' height='100%25' fill='${fill}'/%3E%3C/svg%3E`;

const HTML = [
	`<p><img src="${svg(40, 30, '%235580c0')}" alt="外链图案" /></p>`,
	`<p><a href="https://example.com/page"><img src="${svg(30, 30, '%23aa3333')}" alt="链接内图" /></a></p>`,
	`<p><img src="/definitely-missing-xyz.png" alt="坏图" /></p>`,
	`<p><img src="${svg(20, 20, '%2333aa55')}" alt="" /></p>`
].join('\n');

function enhanced(): HTMLImageElement[] {
	return [...document.querySelectorAll<HTMLImageElement>('img[data-content-lightbox]')];
}

async function mount(): Promise<void> {
	await render(MarkdownRenderer, { html: HTML });
	// Broken images finish their (failed) load asynchronously; wait for the
	// quiet state before asserting the skip rules.
	await new Promise((resolve) => setTimeout(resolve, 200));
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('content lightbox (3d)', () => {
	it('enhances loadable article images into layout-neutral button controls', async () => {
		await mount();
		await expect.poll(() => enhanced().length).toBe(2);
		const labels = enhanced()
			.map((image) => image.getAttribute('aria-label'))
			.sort();
		expect(labels).toEqual(['查看大图', '查看大图：外链图案']);
		for (const image of enhanced()) {
			// The control IS the image (no box-changing wrapper): layout stays
			// exactly as rendered, and the element is focusable.
			expect(image.getAttribute('role')).toBe('button');
			expect(image.tabIndex).toBe(0);
			expect(getComputedStyle(image).cursor).toBe('zoom-in');
		}
	});

	it('leaves in-link images and broken images untouched', async () => {
		await mount();
		const linked = document.querySelector<HTMLImageElement>('a img');
		expect(linked).not.toBeNull();
		expect(linked!.hasAttribute('data-content-lightbox')).toBe(false);
		const broken = document.querySelector<HTMLImageElement>('img[alt="坏图"]');
		expect(broken).not.toBeNull();
		expect(broken!.hasAttribute('data-content-lightbox')).toBe(false);
	});

	it('opens the overlay on activation and restores focus to the image on Esc', async () => {
		await mount();
		const trigger = page.getByRole('button', { name: '查看大图：外链图案' });
		await expect.element(trigger).toBeVisible();
		// bits-ui restores focus to the element focused at open time: pin it
		// explicitly so the restore target is deterministic under synthetic
		// clicks (the e2e covers the native click path).
		const control = document.querySelector<HTMLImageElement>(
			'img[aria-label="查看大图：外链图案"]'
		);
		expect(control).not.toBeNull();
		control!.focus();
		expect(document.activeElement).toBe(control);
		control!.click();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await expect.element(page.getByRole('heading', { name: '外链图案' })).toBeInTheDocument();
		const stageImage = document.querySelector<HTMLImageElement>('[data-photos-viewer-stage] img');
		// Data URLs pass through the adapter untouched: shown as-is, no fetch.
		expect(stageImage?.src.startsWith('data:image/svg+xml')).toBe(true);
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
		await expect.poll(() => document.activeElement).toBe(control);
	});

	it('activates via Enter and Space (native button keyboard semantics)', async () => {
		await mount();
		const control = document.querySelector<HTMLImageElement>(
			'img[aria-label="查看大图：外链图案"]'
		);
		expect(control).not.toBeNull();
		control!.focus();
		control!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
		);
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
		control!.focus();
		control!.dispatchEvent(
			new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
		);
		await expect.element(page.getByRole('dialog')).toBeVisible();
	});
});
