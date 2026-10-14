import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
// Pin the UI locale inside the browser iframe (node-side setup cannot reach it).
overwriteGetLocale(() => 'zh-cn');

import MarkdownRenderer from '../editor/MarkdownRenderer.svelte';
import LightboxSwapHarness from './lightbox-swap-harness.svelte';
import { attachContentLightbox } from '../content-lightbox';
import { plainImageItem } from '$lib/components/photos/viewer-source';

/**
 * Content lightbox (3d) integration: the enhancement turns article images
 * THEMSELVES into button-role controls (role/tabindex on the img - no wrapper
 * that could shift layout; see the technique-deviation note in
 * `content-lightbox.ts`), leaves in-link images, embed-card internals and
 * broken images alone, and clicking a control opens the shared overlay viewer
 * which closes on Esc with focus handed back to the image. The sources are
 * self-contained SVG data URLs - they decode immediately (no network) and
 * pass through the adapter untouched. Direct `attachContentLightbox` cases
 * pin the skip rules and the layout-neutrality deterministically; the swap
 * case pins the review-3d close-on-rerender guard.
 */
const svg = (width: number, height: number, fill: string) =>
	`data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'%3E%3Crect width='100%25' height='100%25' fill='${fill}'/%3E%3C/svg%3E`;

const HTML = [
	`<p><img src="${svg(40, 30, '%235580c0')}" alt="外链图案" /></p>`,
	`<p><a href="https://example.com/page"><img src="${svg(30, 30, '%23aa3333')}" alt="链接内图" /></a></p>`,
	// Broken fixture: a malformed data URL decodes straight to the error
	// state (complete, naturalWidth 0). A missing path would hang forever in
	// the vitest browser server (unknown paths never settle - probed), so it
	// could not drive the guard deterministically.
	`<p><img src="data:image/png;base64,AAAA" alt="坏图" /></p>`,
	`<p><img src="${svg(20, 20, '%2333aa55')}" alt="" /></p>`
].join('\n');

function enhanced(): HTMLImageElement[] {
	return [...document.querySelectorAll<HTMLImageElement>('img[data-content-lightbox]')];
}

async function mount(): Promise<void> {
	await render(MarkdownRenderer, { html: HTML });
	// Settle on the deterministic signal - the two loadable images ARE
	// enhanced; every negative assertion below then runs against a state
	// the enhancement has actually reached (no fixed-sleep window).
	await expect.poll(() => enhanced().length).toBe(2);
}

describe('content lightbox (3d)', () => {
	it('enhances loadable article images into focusable controls (the image itself)', async () => {
		await mount();
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
		// Deterministic broken state: complete with zero intrinsic size first.
		await expect.poll(() => broken!.complete && broken!.naturalWidth === 0).toBe(true);
		expect(broken!.hasAttribute('data-content-lightbox')).toBe(false);
	});

	it('skips embed-card internals and in-link images even when loaded (direct attach)', async () => {
		const host = document.createElement('div');
		host.innerHTML = [
			`<div class="embed-card-mount"><img src="${svg(16, 16, '%23ff0000')}" alt="favicon" /></div>`,
			`<p><a href="#anchor"><img src="${svg(24, 24, '%2300ff00')}" alt="链内" /></a></p>`,
			`<p><img src="${svg(32, 32, '%230000ff')}" alt="普通" /></p>`
		].join('\n');
		document.body.appendChild(host);
		const images = [...host.querySelectorAll<HTMLImageElement>('img')];
		await expect
			.poll(() => images.every((image) => image.complete && image.naturalWidth > 0))
			.toBe(true);
		const onOpen = vi.fn();
		attachContentLightbox(host, onOpen);
		const controls = [...host.querySelectorAll<HTMLImageElement>('img[data-content-lightbox]')];
		expect(controls.length).toBe(1);
		expect(controls[0]).toBe(images[2]);
		// A stray activation on a skipped image must not open anything.
		images[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		images[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(onOpen).not.toHaveBeenCalled();
		// ...while the real control still works.
		images[2].dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
		);
		expect(onOpen).toHaveBeenCalledTimes(1);
		host.remove();
	});

	it('never enhances a broken image (deterministic: decoded failure first)', async () => {
		const host = document.createElement('div');
		// Malformed data URL: errors deterministically (a missing path never
		// settles in the vitest browser server - probed).
		host.innerHTML = '<img src="data:image/png;base64,AAAA" alt="坏图" />';
		document.body.appendChild(host);
		const image = host.querySelector<HTMLImageElement>('img')!;
		await expect.poll(() => image.complete && image.naturalWidth === 0).toBe(true);
		const onOpen = vi.fn();
		attachContentLightbox(host, onOpen);
		expect(image.hasAttribute('data-content-lightbox')).toBe(false);
		image.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(onOpen).not.toHaveBeenCalled();
		host.remove();
	});

	it('enhancement is layout-neutral (no wrapper inserted, same box)', async () => {
		const host = document.createElement('div');
		host.innerHTML = `<p><img src="${svg(40, 30, '%235580c0')}" alt="几何" /></p>`;
		document.body.appendChild(host);
		const image = host.querySelector<HTMLImageElement>('img')!;
		const paragraph = image.parentElement;
		await expect.poll(() => image.complete && image.naturalWidth > 0).toBe(true);
		const before = image.getBoundingClientRect().toJSON();
		attachContentLightbox(host, vi.fn());
		expect(image.hasAttribute('data-content-lightbox')).toBe(true);
		expect(image.parentElement).toBe(paragraph);
		expect(image.getBoundingClientRect().toJSON()).toEqual(before);
		host.remove();
	});

	it('derives @full from a live DOM img (absolute-URL seam, review 3d P1)', () => {
		const key = `ab/ab${'1'.repeat(62)}`;
		const img = document.createElement('img');
		img.setAttribute('src', `/i/${key}.png@preview`);
		document.body.appendChild(img);
		// IDL reads are absolute - the seam the derivation must survive.
		expect(img.src.startsWith('http')).toBe(true);
		expect(plainImageItem(img).fullSrc).toBe(`/i/${key}.png@full`);
		const gif = document.createElement('img');
		gif.setAttribute('src', '/i/ab/legacy.gif@preview');
		document.body.appendChild(gif);
		const gifItem = plainImageItem(gif);
		expect(gifItem.fullSrc).toBe(gifItem.src); // GIF stays single-layer
		img.remove();
		gif.remove();
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

	it('activates via Enter and Space (hand-rolled handler; defaults cancelled)', async () => {
		await mount();
		const control = document.querySelector<HTMLImageElement>(
			'img[aria-label="查看大图：外链图案"]'
		);
		expect(control).not.toBeNull();
		control!.focus();
		// dispatchEvent returns false exactly when the handler cancelled the
		// default (Space would otherwise scroll the page).
		expect(
			control!.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
			)
		).toBe(false);
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
		control!.focus();
		expect(
			control!.dispatchEvent(
				new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
			)
		).toBe(false);
		await expect.element(page.getByRole('dialog')).toBeVisible();
	});

	it('closes an open lightbox when the content swaps and re-enhances the fresh tree', async () => {
		const htmlA = `<p><img src="${svg(40, 30, '%235580c0')}" alt="旧图" /></p>`;
		const htmlB = `<p><img src="${svg(40, 30, '%23aa3333')}" alt="新图" /></p>`;
		await render(LightboxSwapHarness, { htmlA, htmlB });
		await expect
			.poll(() => !!document.querySelector('img[alt="旧图"][data-content-lightbox]'))
			.toBe(true);
		const oldImg = document.querySelector<HTMLImageElement>('img[alt="旧图"]')!;
		oldImg.focus();
		oldImg.click();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		// Programmatic click: a modal dialog blocks pointer hit-testing on
		// purpose (the real-world trigger is an SPA navigation).
		document.querySelector<HTMLButtonElement>('button')!.click();
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
		await expect.poll(() => document.querySelectorAll('img[data-content-lightbox]').length).toBe(1);
		expect(document.querySelector('img[alt="旧图"]')).toBeNull();
		expect(document.querySelector('img[alt="新图"][data-content-lightbox]')).not.toBeNull();
	});
});
