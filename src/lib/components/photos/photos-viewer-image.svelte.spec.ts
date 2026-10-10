import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import PhotosViewerImage from './photos-viewer-image.svelte';
import type { ViewerImageSource } from './viewer-load';

/**
 * T10/T16 stage gate (plan §4.5): streaming progress → blob swap, the
 * 300ms-delayed floater (appears on the long path, never on a fast one),
 * terminal-only live-region announcements, retry on failure, and the
 * on-demand branch (over-threshold / saveData) waiting for an explicit
 * click. Fetch is stubbed with a real streaming Response so the component's
 * ReadableStream accounting runs unmodified.
 */

overwriteGetLocale(() => 'en');

const originalFetch = globalThis.fetch;

let seq = 0;
function photo(overrides: Partial<ViewerImageSource> = {}): ViewerImageSource {
	seq += 1;
	return {
		id: `v-${seq}`,
		slug: `v-${seq}`,
		title: null,
		description: null,
		takenAt: null,
		cameraMake: null,
		cameraModel: null,
		lensModel: null,
		objectKey: `aa/${'b'.repeat(60)}${seq}.jpg`,
		fileName: `v-${seq}.jpg`,
		mimeType: 'image/jpeg',
		width: 4000,
		height: 3000,
		thumbhash: null,
		byteSize: 1200,
		...overrides
	};
}

function streamResponse(chunks: number, _chunkSize: number, delayMs: number, totalSize: number) {
	const chunk = new Uint8Array(4096);
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (let index = 0; index < chunks; index += 1) {
				if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
				controller.enqueue(chunk);
			}
			controller.close();
		}
	});
	return new Response(stream, {
		status: 200,
		headers: { 'content-type': 'image/webp', 'content-length': String(totalSize) }
	});
}

async function until(check: () => boolean, timeoutMs = 6000): Promise<void> {
	const start = performance.now();
	while (!check()) {
		if (performance.now() - start > timeoutMs) throw new Error('condition not met in time');
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const instances: Array<() => void> = [];

function mountStage(photoData: ViewerImageSource): { host: HTMLElement } {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const instance = mount(PhotosViewerImage, {
		target: host,
		props: { photo: photoData, alt: 'test image' }
	});
	instances.push(() => {
		unmount(instance);
	});
	return { host };
}

beforeEach(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	while (instances.length > 0) instances.pop()!();
	document.body.innerHTML = '';
});

describe('photos viewer image stage', () => {
	it('streams the full image, shows the floater past 300ms, swaps to a blob URL and announces completion', async () => {
		const total = 3 * 4096;
		vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
			Promise.resolve(streamResponse(3, 4096, 150, total))
		);
		const { host } = mountStage(photo());

		const img = () => host.querySelector<HTMLImageElement>('.photos-viewer-image')!;
		// Interim: the thumb tier, never the full URL.
		expect(img().src).toMatch(/(?:%40|@)thumb/);
		await until(() => host.querySelector('.photos-viewer-progress') !== null);
		// In-flight copy carries the ring detail.
		expect(host.querySelector('.photos-viewer-progress')!.textContent).toContain('Loading');
		await until(() => img().src.startsWith('blob:'));
		expect(img().dataset.phase).toBe('done');
		await until(() => host.querySelector('.photos-viewer-progress') === null);
		const live = host.querySelector('[aria-live="polite"]')!;
		expect(live.textContent).toBe('Full image loaded');
		// The interim URL is no longer served once the blob is in place.
		expect(img().src).not.toContain('thumb');
	});

	it('keeps the floater off for a fast (cache-hit) load', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
			Promise.resolve(streamResponse(1, 4096, 0, 4096))
		);
		const { host } = mountStage(photo());
		await until(() =>
			host.querySelector<HTMLImageElement>('.photos-viewer-image')!.src.startsWith('blob:')
		);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(host.querySelector('.photos-viewer-progress')).toBeNull();
	});

	it('a terminal failure shows the retry and recovers on click', async () => {
		const spy = vi.spyOn(globalThis, 'fetch');
		spy.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 404 })));
		const { host } = mountStage(photo());
		await until(() => host.querySelector('.photos-viewer-retry') !== null);
		expect(host.querySelector('.photos-viewer-progress')!.textContent).toContain(
			'The full image could not be loaded.'
		);
		const live = host.querySelector('[aria-live="polite"]')!;
		expect(live.textContent).toBe('The full image could not be loaded.');

		spy.mockImplementation(() => Promise.resolve(streamResponse(1, 4096, 0, 4096)));
		host.querySelector<HTMLButtonElement>('.photos-viewer-retry')!.click();
		await until(() =>
			host.querySelector<HTMLImageElement>('.photos-viewer-image')!.src.startsWith('blob:')
		);
		expect(live.textContent).toBe('Full image loaded');
	});

	it('over-threshold sources wait for an explicit click', async () => {
		const spy = vi.spyOn(globalThis, 'fetch');
		spy.mockImplementation(() => Promise.resolve(streamResponse(1, 4096, 0, 4096)));
		const { host } = mountStage(photo({ byteSize: 9_000_000 }));
		const button = () => host.querySelector<HTMLButtonElement>('.photos-viewer-load');
		await until(() => button() !== null);
		expect(button()!.textContent).toContain('Load full image');
		expect(button()!.textContent).toContain('8.6 MB');
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(spy).not.toHaveBeenCalled();

		button()!.click();
		await until(() =>
			host.querySelector<HTMLImageElement>('.photos-viewer-image')!.src.startsWith('blob:')
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('a saveData signal forces on-demand for a small file', async () => {
		const original = Object.getOwnPropertyDescriptor(navigator, 'connection');
		Object.defineProperty(navigator, 'connection', {
			configurable: true,
			value: { saveData: true }
		});
		try {
			const spy = vi.spyOn(globalThis, 'fetch');
			spy.mockImplementation(() => Promise.resolve(streamResponse(1, 4096, 0, 4096)));
			const { host } = mountStage(photo({ byteSize: 1200 }));
			await until(() => host.querySelector('.photos-viewer-load') !== null);
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(spy).not.toHaveBeenCalled();
		} finally {
			if (original) Object.defineProperty(navigator, 'connection', original);
			else delete (navigator as unknown as Record<string, unknown>).connection;
		}
	});
});
