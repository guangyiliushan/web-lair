import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
// Pin the UI locale inside the browser iframe (node-side setup cannot reach it).
overwriteGetLocale(() => 'zh-cn');

import PhotosViewerOverlay from './photos-viewer-overlay.svelte';
import type { PhotoViewerSource } from './photo-tile';

/**
 * Overlay viewer v1.1 (3c): shell open/close, counter/caption, keyboard
 * transform drive, arrow navigation with the lazy neighbourhood fetch,
 * backdrop vs image click semantics and wheel zoom. Gesture end-to-end
 * behaviour (pinch/pan on touch) lives in the e2e layer; the maths is pinned
 * by viewer-transform.test.ts.
 */
const PNG_KEY = `ab/${'a'.repeat(64)}.png`;

function viewerPhoto(overrides: Partial<PhotoViewerSource> = {}): PhotoViewerSource {
	return {
		id: 'photo-1',
		slug: 'sunset',
		title: { en: 'Sunset' },
		description: null,
		objectKey: PNG_KEY,
		fileName: 'sunset.png',
		mimeType: 'image/png',
		width: 800,
		height: 600,
		thumbhash: null,
		byteSize: 1000,
		...overrides
	};
}

interface OverlayInit {
	open?: boolean;
	photo?: PhotoViewerSource;
	neighbors?: {
		newer: PhotoViewerSource | null;
		older: PhotoViewerSource | null;
	};
	position?: { index: number; total: number };
	onClosed?: (slug: string) => void;
}

async function host(props: OverlayInit) {
	await render(PhotosViewerOverlay, {
		open: true,
		photo: viewerPhoto(),
		neighbors: {
			newer: viewerPhoto({ id: 'newer', slug: 'newer-photo', title: { en: 'Newer' } }),
			older: null
		},
		position: { index: 2, total: 5 },
		...props
	});
}

function stage(): HTMLElement {
	const el = document.querySelector<HTMLElement>('[data-photos-viewer-stage]');
	expect(el).not.toBeNull();
	return el!;
}

function captionText(): string {
	return document.querySelector('[data-photos-viewer-caption]')?.textContent ?? '';
}

function transformStyle(): string {
	return document.querySelector('img')?.style.transform ?? '';
}

function pressKey(key: string): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith('/api/photo-neighbors')) {
				return new Response(
					JSON.stringify({
						photo: { slug: 'older-photo' },
						newer: { ...viewerPhoto(), id: 'mid', slug: 'newer-after' },
						older: { ...viewerPhoto(), id: 'old', slug: 'oldest-photo' },
						position: { index: 3, total: 5 }
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			// The full-variant fetch: a tiny body with a length header.
			return new Response(new Uint8Array([1, 2, 3]), {
				headers: { 'content-type': 'image/png', 'content-length': '3' }
			});
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('overlay viewer shell (3c)', () => {
	it('shows the counter, caption and localised controls when open', async () => {
		await host({});
		await expect(page.getByText('2 / 5')).toBeVisible();
		// The sr-only Dialog title and description also carry the text; the
		// caption is pinned by its data hook.
		await expect.poll(() => captionText()).toBe('Sunset');
		await expect(page.getByRole('heading', { name: 'Sunset' })).toBeInTheDocument();
		await expect(page.getByRole('button', { name: '关闭查看器' })).toBeVisible();
		expect(stage()).toBeTruthy();
	});

	it('the close button closes and reports the current slug once', async () => {
		const onClosed = vi.fn<(slug: string) => void>();
		await host({ onClosed });
		await page.getByRole('button', { name: '关闭查看器' }).click();
		await expect.poll(() => onClosed.mock.calls.length).toBe(1);
		expect(onClosed).toHaveBeenCalledWith('sunset');
		await expect.element(page.getByText('2 / 5')).not.toBeInTheDocument();
		expect(document.querySelector('[data-photos-viewer-stage]')).toBeNull();
	});

	it('+/-/0 keys drive the transform scale', async () => {
		await host({});
		await expect.poll(() => document.querySelector('img')).not.toBeNull();
		pressKey('+');
		await expect.poll(() => transformStyle()).toContain('scale(1.5)');
		pressKey('-');
		await expect.poll(() => transformStyle()).toContain('scale(1)');
		pressKey('+');
		await expect.poll(() => transformStyle()).toContain('scale(1.5)');
		pressKey('0');
		await expect.poll(() => transformStyle()).toContain('scale(1)');
	});

	it('ArrowRight walks to the older neighbour and extends the window', async () => {
		await host({
			neighbors: {
				newer: null,
				older: viewerPhoto({ id: 'older', slug: 'older-photo', title: { en: 'Older' } })
			}
		});
		pressKey('ArrowRight');
		await expect.poll(() => captionText()).toBe('Older');
		await expect.poll(() => document.body.textContent ?? '').toContain('3 / 5');
		const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
		expect(
			fetchMock.mock.calls.some((call) =>
				String(call[0]).includes('/api/photo-neighbors?slug=older-photo')
			)
		).toBe(true);
	});

	it('clicking the backdrop closes; clicking the image does not', async () => {
		const onClosed = vi.fn<(slug: string) => void>();
		await host({ onClosed });
		const image = document.querySelector('img');
		expect(image).not.toBeNull();
		image!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await expect.element(page.getByText('2 / 5')).toBeVisible();
		expect(onClosed).not.toHaveBeenCalled();
		stage().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await expect.poll(() => onClosed.mock.calls.length).toBe(1);
	});

	it('wheel zooms at the pointer', async () => {
		await host({});
		await expect.poll(() => document.querySelector('img')).not.toBeNull();
		stage().dispatchEvent(
			new WheelEvent('wheel', {
				deltaY: -100,
				clientX: 640,
				clientY: 400,
				bubbles: true,
				cancelable: true
			})
		);
		await expect.poll(() => transformStyle()).toContain('scale(1.15)');
	});
});
