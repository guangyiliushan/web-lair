import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { isHeic } from './heic';
import { processImage } from './variants';

const HEIC_FIXTURE = new URL('./fixtures/example.heic', import.meta.url);

async function solid(width: number, height: number): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: { r: 51, g: 102, b: 170 } } })
		.png()
		.toBuffer();
}

describe('processImage (ledger §21 pipeline)', () => {
	it('keeps aspect ratios and never enlarges (T8: landscape / portrait / square / panorama)', async () => {
		const cases: Array<{ w: number; h: number }> = [
			{ w: 800, h: 600 },
			{ w: 600, h: 800 },
			{ w: 500, h: 500 },
			{ w: 1600, h: 400 }
		];
		for (const { w, h } of cases) {
			const out = await processImage(await solid(w, h));
			const thumb = await sharp(out.variants.thumb).metadata();
			expect([out.width, out.height]).toEqual([w, h]);
			expect(thumb.width).toBeLessThanOrEqual(480);
			expect(thumb.height).toBeLessThanOrEqual(480);
			expect(thumb.width! / thumb.height!).toBeCloseTo(w / h, 2);
			expect(out.variants.preview).toBeNull();
			const full = await sharp(out.variants.full).metadata();
			expect([full.width, full.height]).toEqual([w, h]);
		}
	});

	it('does not enlarge images already inside the thumb box', async () => {
		const out = await processImage(await solid(300, 200));
		const thumb = await sharp(out.variants.thumb).metadata();
		expect([thumb.width, thumb.height]).toEqual([300, 200]);
	});

	it('generates preview only when the long edge exceeds 2560', async () => {
		const out = await processImage(await solid(3000, 1500));
		expect(out.variants.preview).not.toBeNull();
		const preview = await sharp(out.variants.preview!).metadata();
		expect([preview.width, preview.height]).toEqual([2560, 1280]);
		expect([out.width, out.height]).toEqual([3000, 1500]);
	});

	it('bakes EXIF orientation into the pixels and strips metadata from public variants', async () => {
		const oriented = await sharp({
			create: { width: 100, height: 60, channels: 3, background: { r: 51, g: 102, b: 170 } }
		})
			.withMetadata({ orientation: 6, exif: { IFD0: { Make: 'web-lair-test' } } })
			.jpeg()
			.toBuffer();
		const out = await processImage(oriented);
		expect([out.width, out.height]).toEqual([60, 100]);
		for (const variant of [out.variants.thumb, out.variants.full]) {
			const meta = await sharp(variant).metadata();
			expect(meta.exif).toBeUndefined();
			expect(meta.orientation).toBeUndefined();
		}
	});

	it('decodes HEIC through the WASM path (T7) and yields the full chain', async () => {
		const heic = await readFile(HEIC_FIXTURE);
		expect(isHeic(heic)).toBe(true);
		expect(isHeic(await solid(4, 4))).toBe(false);

		const out = await processImage(heic);
		expect([out.width, out.height]).toEqual([1280, 854]);
		const thumb = await sharp(out.variants.thumb).metadata();
		expect(thumb.width).toBe(480);
		expect(thumb.height).toBeGreaterThanOrEqual(319);
		expect(thumb.height).toBeLessThanOrEqual(321);
		const full = await sharp(out.variants.full).metadata();
		expect([full.width, full.height]).toEqual([1280, 854]);
		expect(out.variants.preview).toBeNull();
		expect(out.thumbhash.length).toBeGreaterThan(10);
		expect(out.palette.dominant).toHaveLength(3);
	});

	it('keeps the libheif floor at ≥1.22 (CVE line, ledger §21)', async () => {
		const pkg = JSON.parse(
			await readFile(
				new URL('../../../../node_modules/libheif-js/package.json', import.meta.url),
				'utf8'
			)
		) as { version: string };
		const [major, minor] = pkg.version.split('.').map(Number);
		expect(major > 1 || (major === 1 && minor >= 22)).toBe(true);
	});
});
