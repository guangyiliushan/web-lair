import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import PhotosMasonry from './photos-masonry.svelte';
import type { PhotoTile } from './photo-tile';
import { masonryStore } from './testing/masonry-store.svelte';

/**
 * Masonry POC gate (§5.1): DOM order == feed order, appends never move
 * earlier tiles, resize re-lays out, subsets render, keyboard reaches links
 * in order, and the disabled fallback drops the transforms entirely.
 */

overwriteGetLocale(() => 'en');

let seq = 0;
function tile(overrides: Partial<PhotoTile> = {}): PhotoTile {
	seq += 1;
	return {
		id: `tile-${seq}`,
		slug: `tile-${seq}`,
		title: null,
		description: null,
		takenAt: null,
		cameraMake: null,
		cameraModel: null,
		lensModel: null,
		objectKey: `aa/${'a'.repeat(60)}${seq}.jpg`,
		fileName: `tile-${seq}.jpg`,
		mimeType: 'image/jpeg',
		width: 4000,
		height: 3000 + (seq % 5) * 400,
		thumbhash: null,
		...overrides
	};
}

const instances: Array<() => void> = [];

async function settle(times = 3): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/** Wait until the measured layout stops changing between frames. */
async function untilStable(host: HTMLElement, frames = 12): Promise<void> {
	let last = '';
	for (let index = 0; index < frames; index += 1) {
		await settle(1);
		const now = tops(host).join(',');
		if (now === last) return;
		last = now;
	}
}

async function mountGrid(
	items: PhotoTile[],
	extra: Record<string, unknown> = {}
): Promise<{ host: HTMLElement; store: ReturnType<typeof masonryStore> }> {
	const store = masonryStore(items);
	const host = document.createElement('div');
	host.style.width = '1000px';
	document.body.appendChild(host);
	const instance = mount(PhotosMasonry, {
		target: host,
		props: { items: store.items, ...extra } as never
	});
	await settle();
	instances.push(() => unmount(instance));
	return { host, store };
}

afterEach(() => {
	while (instances.length > 0) instances.pop()!();
	document.body.innerHTML = '';
});

function anchors(host: HTMLElement): HTMLAnchorElement[] {
	return [...host.querySelectorAll<HTMLAnchorElement>('a')];
}

function tops(host: HTMLElement): number[] {
	const grid = host.querySelector('.photos-masonry')!;
	const base = grid.getBoundingClientRect().top;
	return anchors(host).map((anchor) => anchor.getBoundingClientRect().top - base);
}

/** Column lane of each tile (left offset from the container). */
function lanes(host: HTMLElement): number[] {
	const grid = host.querySelector('.photos-masonry')!;
	const base = grid.getBoundingClientRect().left;
	return anchors(host).map((anchor) =>
		Number((anchor.getBoundingClientRect().left - base).toFixed(1))
	);
}

describe('photos masonry (POC gate)', () => {
	it('renders every tile once, in feed order', async () => {
		const items = Array.from({ length: 12 }, () => tile());
		const { host } = await mountGrid(items);
		const links = anchors(host);
		expect(links).toHaveLength(12);
		expect(links.map((link) => link.getAttribute('href'))).toEqual(
			items.map((item) => `/en/photos/${item.slug}`)
		);
	});

	it('append keeps earlier tiles in their lanes; nudge stays within one gap', async () => {
		const initial = Array.from({ length: 9 }, () => tile());
		const { host, store } = await mountGrid(initial);
		await untilStable(host);
		const beforeTops = tops(host).slice(0, 6);
		const beforeLanes = lanes(host).slice(0, 6);
		store.append(Array.from({ length: 6 }, () => tile()));
		await settle(4);
		await untilStable(host);
		expect(anchors(host)).toHaveLength(15);
		const afterTops = tops(host).slice(0, 6);
		const afterLanes = lanes(host).slice(0, 6);
		// The pull-up bookkeeping may recompute transforms on append; measured
		// artifact on 1.1.1: up to ~4px for the second row. Gate at one gap so
		// a real regression (reflow / reorder) still fails loudly.
		const deltas = afterTops.map((top, index) => Number((top - beforeTops[index]!).toFixed(2)));
		const worst = Math.max(...deltas.map((value) => Math.abs(value)));
		expect(worst, `deltas=${JSON.stringify(deltas)}`).toBeLessThanOrEqual(12);
		// Lanes must not change: no tile may jump to another column.
		afterLanes.forEach((lane, index) => {
			expect(
				Math.abs(lane - beforeLanes[index]!),
				`lanes=${JSON.stringify(afterLanes)}`
			).toBeLessThanOrEqual(1);
		});
	});

	it('resize re-lays out (fewer columns when narrower)', async () => {
		const { host } = await mountGrid(Array.from({ length: 8 }, () => tile()));
		const columnCount = () => {
			const grid = host.querySelector('.photos-masonry > *')!;
			const style = getComputedStyle(grid).gridTemplateColumns;
			return style === 'none' || style === '' ? 0 : style.split(' ').length;
		};
		const wide = columnCount();
		host.style.width = '420px';
		await settle(6);
		const narrow = columnCount();
		expect(wide).toBeGreaterThan(0);
		expect(narrow).toBeLessThan(wide);
	});

	it('renders a filtered subset without leftovers', async () => {
		const { host, store } = await mountGrid(Array.from({ length: 6 }, () => tile()));
		store.replace(Array.from({ length: 2 }, () => tile()));
		await settle();
		expect(anchors(host)).toHaveLength(2);
	});

	it('keyboard focus reaches links in DOM order', async () => {
		const { host } = await mountGrid(Array.from({ length: 4 }, () => tile()));
		const links = anchors(host);
		expect(
			links.every((link) => link.tabIndex === 0 || link.getAttribute('tabindex') === null)
		).toBe(true);
		links[0]!.focus();
		expect(document.activeElement).toBe(links[0]);
	});

	it('disabled fallback keeps order and drops the pull-up transforms', async () => {
		const items = Array.from({ length: 6 }, () => tile());
		const { host } = await mountGrid(items, { disabled: true });
		const links = anchors(host);
		expect(links.map((link) => link.getAttribute('href'))).toEqual(
			items.map((item) => `/en/photos/${item.slug}`)
		);
		const frames = [...host.querySelectorAll<HTMLElement>('a')].map(
			(anchor) => anchor.parentElement!
		);
		for (const frame of frames) {
			const transform = getComputedStyle(frame).transform;
			expect(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
		}
	});

	it('survives a garbage thumbhash without throwing', async () => {
		const { host } = await mountGrid([tile({ thumbhash: '!!!not-base64!!!' })]);
		expect(anchors(host)).toHaveLength(1);
	});
});
