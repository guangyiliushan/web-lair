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
 * transform drive, arrow navigation with the lazy neighbourhood fetch
 * (payload adoption pinned by DISTINCT numbers), backdrop vs image clicks,
 * anchored wheel zoom, pointer-gesture wiring (swipe navigate / swipe-down
 * close / drag-click suppression - the review-01 P2-1 delay tooth), the
 * in-flight load invalidation on the on-demand branch (review-01 P1) and the
 * thumb-only neighbour prefetch tiers. The transform maths lives in
 * viewer-transform.test.ts; the T10/T16 branches have e2e coverage.
 */
const KEY_A = `ab/aa${'a'.repeat(62)}.png`;
const KEY_NEW = `ab/aa${'1'.repeat(62)}.png`;
const KEY_HANG = `ab/bb${'b'.repeat(62)}.jpg`;

/** A real decodable PNG (canvas 800x600): the browser then lays the <img>
 * out at its intrinsic ratio, so click-geometry and pan clamping behave
 * like production instead of the broken-image balloon. */
async function pngResponse(): Promise<Response> {
	const canvas = document.createElement('canvas');
	canvas.width = 800;
	canvas.height = 600;
	const context = canvas.getContext('2d');
	if (context) {
		context.fillStyle = '#5580c0';
		context.fillRect(0, 0, 800, 600);
	}
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
	return new Response(blob, { headers: { 'content-type': 'image/png' } });
}

function viewerPhoto(overrides: Partial<PhotoViewerSource> = {}): PhotoViewerSource {
	return {
		id: 'photo-1',
		slug: 'sunset',
		title: { en: 'Sunset' },
		description: null,
		objectKey: KEY_A,
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
			newer: viewerPhoto({
				id: 'newer',
				slug: 'newer-photo',
				title: { en: 'Newer' },
				objectKey: KEY_NEW
			}),
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

function counterText(): string {
	return document.querySelector('[data-photos-viewer-counter]')?.textContent?.trim() ?? '';
}

function transformStyle(): string {
	return (
		document.querySelector<HTMLImageElement>('[data-photos-viewer-stage] img')?.style.transform ??
		''
	);
}

function pressKey(key: string): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function pointer(type: string, x: number, y: number): void {
	stage().dispatchEvent(
		new PointerEvent(type, {
			pointerId: 1,
			pointerType: 'touch',
			isPrimary: true,
			clientX: x,
			clientY: y,
			button: 0,
			buttons: type === 'pointerup' ? 0 : 1,
			bubbles: true,
			cancelable: true
		})
	);
}

async function tune(): Promise<void> {
	// A few milliseconds between pointer events: the library's zero-delay gate
	// still requires a strictly positive time delta.
	await new Promise((resolve) => setTimeout(resolve, 12));
}

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith('/api/photo-neighbors')) {
				const slug = new URL(url, 'http://local').searchParams.get('slug') ?? '';
				return new Response(
					JSON.stringify({
						slug,
						newer: {
							...viewerPhoto(),
							id: 'payload-newer',
							slug: 'newer-after',
							title: { en: 'Payload neighbor' }
						},
						older: {
							...viewerPhoto(),
							id: 'payload-older',
							slug: 'oldest-photo',
							title: { en: 'Payload older' }
						},
						position: { index: 4, total: 9 }
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			return pngResponse();
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
		await expect.poll(() => counterText()).toBe('2 / 5');
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
		await expect.poll(() => counterText()).toBe('');
		expect(document.querySelector('[data-photos-viewer-stage]')).toBeNull();
	});

	it('+/-/0 keys drive the transform scale', async () => {
		await host({});
		await expect
			.poll(() => document.querySelector('[data-photos-viewer-stage] img'))
			.not.toBeNull();
		pressKey('+');
		await expect.poll(() => transformStyle()).toContain('scale(1.5)');
		pressKey('-');
		await expect.poll(() => transformStyle()).toContain('scale(1)');
		pressKey('+');
		await expect.poll(() => transformStyle()).toContain('scale(1.5)');
		pressKey('0');
		await expect.poll(() => transformStyle()).toContain('scale(1)');
	});

	it('ArrowRight adopts the fetched payload (distinct numbers, then payload-walk back)', async () => {
		await host({
			neighbors: {
				newer: null,
				older: viewerPhoto({ id: 'older', slug: 'older-photo', title: { en: 'Older' } })
			}
		});
		pressKey('ArrowRight');
		// The caption comes from the provisional window in the props...
		await expect.poll(() => captionText()).toBe('Older');
		// ...but the counter only reaches the payload's DISTINCT numbers when
		// the response is really adopted (provisional would say 3 / 5).
		await expect.poll(() => counterText()).toBe('4 / 9');
		// Walk onward using the PAYLOAD's newer neighbour, not the props.
		pressKey('ArrowLeft');
		await expect.poll(() => captionText()).toBe('Payload neighbor');
		const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
		const requested = fetchMock.mock.calls.map((call) => String(call[0]));
		expect(requested.some((url) => url.includes('slug=older-photo'))).toBe(true);
		expect(requested.some((url) => url.includes('slug=newer-after'))).toBe(true);
	});

	it('clicking the backdrop closes; clicking the image does not', async () => {
		const onClosed = vi.fn<(slug: string) => void>();
		await host({ onClosed });
		const image = document.querySelector('[data-photos-viewer-stage] img');
		expect(image).not.toBeNull();
		await expect.poll(() => counterText()).toBe('2 / 5');
		(image as HTMLImageElement).dispatchEvent(
			new MouseEvent('click', { bubbles: true, cancelable: true })
		);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(counterText()).toBe('2 / 5');
		expect(onClosed).not.toHaveBeenCalled();
		stage().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await expect.poll(() => onClosed.mock.calls.length).toBe(1);
	});

	it('wheel zoom is anchored at an off-centre pointer', async () => {
		await host({});
		const wheelImage = () =>
			document.querySelector('[data-photos-viewer-stage] img') as HTMLImageElement | null;
		// Wait for the DECODED image: clamping reads its laid-out box, and the
		// broken interim (natural 0x0) would give a different content size.
		await expect.poll(() => wheelImage()?.naturalWidth ?? 0).toBeGreaterThan(0);
		for (let step = 0; step < 4; step += 1) {
			stage().dispatchEvent(
				new WheelEvent('wheel', {
					deltaY: -100,
					clientX: 100,
					clientY: 360,
					bubbles: true,
					cancelable: true
				})
			);
		}
		// Four wheels: 1.15^4 = 1.749 - past the point where the 800px-wide
		// source (no upscaling: max-* only caps) exceeds the stage, giving the
		// clamp room to expose the anchored offset.
		await expect.poll(() => transformStyle()).toContain('scale(1.74');
		// Scientific notation is a valid serialization of tiny float noise.
		const match = /translate3d\((-?[\d.eE+-]+)px, (-?[\d.eE+-]+)px/.exec(transformStyle());
		expect(match).not.toBeNull();
		// Anchoring at a point left of centre moves the content to the RIGHT
		// (positive x); a dropped or sign-flipped anchor clamps to 0.
		expect(Number(match![1])).toBeGreaterThan(20);
	});

	it('a fast swipe navigates (no pan delay gate)', async () => {
		await host({
			neighbors: {
				newer: null,
				older: viewerPhoto({ id: 'older', slug: 'older-photo', title: { en: 'Older' } })
			}
		});
		pointer('pointerdown', 900, 360);
		await tune();
		pointer('pointermove', 820, 360);
		await tune();
		pointer('pointermove', 770, 360);
		await tune();
		pointer('pointerup', 770, 360);
		await expect.poll(() => captionText()).toBe('Older');
	});

	it('a downward swipe at fit scale closes the overlay', async () => {
		const onClosed = vi.fn<(slug: string) => void>();
		await host({ onClosed });
		pointer('pointerdown', 640, 160);
		await tune();
		pointer('pointermove', 640, 260);
		await tune();
		pointer('pointermove', 640, 300);
		await tune();
		pointer('pointerup', 640, 300);
		await expect.poll(() => onClosed.mock.calls.length).toBe(1);
	});

	it('a drag suppresses the trailing click (no accidental backdrop close)', async () => {
		const onClosed = vi.fn<(slug: string) => void>();
		await host({ onClosed });
		pointer('pointerdown', 300, 300);
		await tune();
		pointer('pointermove', 340, 340); // moved (>6px) but below every threshold
		await tune();
		pointer('pointerup', 340, 340);
		stage().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(onClosed).not.toHaveBeenCalled();
	});

	it('discards an in-flight load when navigating onto an on-demand photo', async () => {
		let releaseHanging: (() => void) | null = null;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes(KEY_A)) {
					return new Promise<Response>((resolve) => {
						releaseHanging = () => void pngResponse().then(resolve);
					});
				}
				return pngResponse();
			})
		);
		await host({
			neighbors: {
				newer: null,
				older: viewerPhoto({
					id: 'big',
					slug: 'big-photo',
					title: { en: 'Big' },
					objectKey: KEY_HANG,
					mimeType: 'image/jpeg',
					byteSize: 20_000_000
				})
			}
		});
		await expect.poll(() => releaseHanging !== null).toBe(true);
		pressKey('ArrowRight');
		await expect.poll(() => captionText()).toBe('Big');
		const loadButton = page.getByRole('button', { name: /加载原图/ });
		await expect.element(loadButton).toBeVisible();
		// Release the STALE stream: its token was invalidated before the
		// on-demand branch returned, so the blob must be discarded (pre-fix it
		// landed as this photo's image and the button vanished).
		releaseHanging!();
		await new Promise((resolve) => setTimeout(resolve, 120));
		await expect.element(loadButton).toBeVisible();
		const image = document.querySelector(
			'[data-photos-viewer-stage] img'
		) as HTMLImageElement | null;
		expect(image?.src.startsWith('blob:') ?? false).toBe(false);
	});

	it('prefetches the neighbours as thumb only (no full, no phantom preview)', async () => {
		const recorded: string[] = [];
		class RecordingImage {
			set src(value: string) {
				recorded.push(value);
			}
		}
		vi.stubGlobal('Image', RecordingImage);
		await host({});
		await expect.poll(() => recorded.length).toBeGreaterThan(0);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(recorded.some((src) => src === `/i/${KEY_NEW}@thumb`)).toBe(true);
		// Q13: full is never prefetched; 800x600 has no preview tier.
		expect(recorded.some((src) => src.includes('@full'))).toBe(false);
		expect(recorded.some((src) => src.includes('@preview'))).toBe(false);
	});
});
