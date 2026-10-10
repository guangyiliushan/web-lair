import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * Storage ST-2d (T12) map acceptance: the public map renders tiles through
 * OUR /maps route (Range-capable, pmtiles protocol) and its markers link to
 * the photo pages. Fixtures use the `e2e-map` marker and are cleaned around
 * every test; the tile assertion listens to real network responses so a
 * broken Range path cannot slip through a mocked render.
 */
const FIX = 'e2e-map';
const FILE_A = '00000000-0000-7000-9000-0000000000b1';

function cleanup(): void {
	psql(`delete from photos where slug like '${FIX}%'`);
	psql(`delete from files where file_name like '${FIX}%'`);
}

function seed(): void {
	psql(
		`insert into files (id, object_key, content_hash, file_name, mime_type, byte_size, width, height, status) values
		 ('${FILE_A}', 'e9/${FIX}-a.jpg', '${FIX}-hash-a', '${FIX}-a.jpg', 'image/jpeg', 1200, 4000, 3000, 'attached')`
	);
	psql(
		`insert into photos (file_id, slug, title, taken_at, latitude, longitude, is_visible) values
		 ('${FILE_A}', '${FIX}-alpha', '{"zh-cn":"E2E 地图照片"}', '2026-01-05T08:00:00+08', 25.033, 121.5654, true)`
	);
}

test.describe.configure({ mode: 'serial', timeout: 300_000 });
test.use(zhCnLocale);

test.beforeEach(() => {
	cleanup();
	seed();
});

test.afterAll(() => {
	cleanup();
});

test.describe('photos public map', () => {
	test('renders tiles from the served PMTiles (206 ranges) and links markers', async ({ page }) => {
		const served: { url: string; status: number }[] = [];
		page.on('response', (response) => {
			if (response.url().includes('/maps/')) {
				served.push({ url: response.url(), status: response.status() });
			}
		});

		await page.goto('/zh-cn/photos/map');
		await expect(page.getByRole('heading', { name: '地图' })).toBeVisible({ timeout: 20_000 });

		// MapLibre painted a canvas (WebGL alive).
		await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 });

		// Tiles flow through OUR route; pmtiles reads use Range, so at least
		// one 206 must appear on the world archive URL.
		await expect
			.poll(() => served.filter((entry) => entry.url.includes('world-z0-6.pmtiles')).length, {
				timeout: 30_000
			})
			.toBeGreaterThan(0);
		const pmtilesHits = served.filter((entry) => entry.url.includes('world-z0-6.pmtiles'));
		expect(pmtilesHits.some((entry) => entry.status === 206)).toBe(true);

		// The located fixture produces a marker that links to its page.
		const marker = page.locator('a.photos-map-marker');
		await expect(marker).toHaveCount(1);
		await expect(marker).toHaveAttribute('href', new RegExp(`${FIX}-alpha$`));
		await marker.click();
		await expect(page).toHaveURL(new RegExp(`${FIX}-alpha$`));
		await expect(page.locator('div.sticky')).toContainText('E2E 地图照片', { timeout: 20_000 });
	});

	test('a photo without coordinates never reaches the map', async ({ page }) => {
		psql(`update photos set latitude = null, longitude = null where slug = '${FIX}-alpha'`);
		await page.goto('/zh-cn/photos/map');
		await expect(page.getByRole('heading', { name: '地图' })).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText('还没有带位置信息的照片。')).toBeVisible();
		await expect(page.locator('a.photos-map-marker')).toHaveCount(0);
	});
});
