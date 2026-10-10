import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * WCAG 2.2 AA baseline for the public photo surfaces (T11's automated half,
 * plan §5.3): zero CRITICAL axe-core violations on the three public pages,
 * plus the 2.5.8 target-size assertions (≥24×24 CSS px) for the viewer
 * controls and map markers. Lower-impact findings are printed for the
 * record (the line's bar is critical-only, per T11). One located fixture
 * gives the map a marker. Fixture dates stay below 2030: photos-public's
 * "no newer neighbour" assertion relies on its own 2030-01 rows being the
 * newest visible photos, and specs share the live database across workers.
 */
const FIX = 'e2e-axe';

const FILE_A = '00000000-0000-7000-9002-0000000000d1';
const FILE_B = '00000000-0000-7000-9002-0000000000d2';

function cleanup(): void {
	psql(`delete from photos where slug like '${FIX}%'`);
	psql(`delete from files where file_name like '${FIX}%'`);
}

function seed(): void {
	psql(
		`insert into files (id, object_key, content_hash, file_name, mime_type, byte_size, width, height, status) values
		 ('${FILE_A}', 'e2/${FIX}-a.jpg', '${FIX}-hash-a', '${FIX}-a.jpg', 'image/jpeg', 1200, 4000, 3000, 'attached'),
		 ('${FILE_B}', 'e2/${FIX}-b.jpg', '${FIX}-hash-b', '${FIX}-b.jpg', 'image/jpeg', 1200, 3000, 4000, 'attached')`
	);
	psql(
		`insert into photos (file_id, slug, title, taken_at, latitude, longitude, is_visible) values
		 ('${FILE_A}', '${FIX}-alpha', '{"zh-cn":"A11y 甲"}', '2029-03-02T08:00:00+08', 25.033, 121.5654, true),
		 ('${FILE_B}', '${FIX}-beta', null, '2029-03-01T08:00:00+08', null, null, true)`
	);
}

const CRITICAL = (violations: Array<{ impact?: string | null }>) =>
	violations.filter((violation) => violation.impact === 'critical');

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.use(zhCnLocale);

test.beforeEach(() => {
	cleanup();
	seed();
});

// Symmetric cleanup: fixtures never outlive their test, keeping the window
// in which other specs can observe (and race) them as small as possible.
test.afterEach(() => {
	cleanup();
});

test.afterAll(() => {
	cleanup();
});

test.describe('photos a11y baseline', () => {
	for (const [name, path] of [
		['gallery', '/zh-cn/photos'],
		['map', '/zh-cn/photos/map'],
		['viewer', `/zh-cn/photos/${FIX}-alpha`]
	] as const) {
		test(`no critical axe violations on the public ${name}`, async ({ page }) => {
			await page.goto(path);
			await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
			const results = await new AxeBuilder({ page }).analyze();
			const summary = results.violations.map(
				(violation) => `${violation.impact}: ${violation.id} (${violation.nodes.length})`
			);
			if (summary.length > 0) console.log(`[axe:${name}]`, summary.join(' | '));
			expect(CRITICAL(results.violations), JSON.stringify(summary)).toEqual([]);
		});
	}

	test('2.5.8: viewer controls and map markers meet 24×24', async ({ page }) => {
		await page.goto(`/zh-cn/photos/${FIX}-alpha`);
		await expect(page.locator('.photos-viewer-image')).toBeVisible({ timeout: 20_000 });
		const controls = [page.locator('div.sticky a').first(), page.locator('div.sticky a').last()];
		for (const control of controls) {
			const box = await control.boundingBox();
			expect(box, 'control missing').not.toBeNull();
			expect(box!.width).toBeGreaterThanOrEqual(24);
			expect(box!.height).toBeGreaterThanOrEqual(24);
		}

		await page.goto('/zh-cn/photos/map');
		const marker = page.locator('a.photos-map-marker').first();
		await expect(marker).toBeVisible({ timeout: 30_000 });
		const box = await marker.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.width).toBeGreaterThanOrEqual(24);
		expect(box!.height).toBeGreaterThanOrEqual(24);
	});

	test('keyboard reaches the viewer back-link by Tab alone', async ({ page }) => {
		await page.goto(`/zh-cn/photos/${FIX}-alpha`);
		await expect(page.locator('.photos-viewer-image')).toBeVisible({ timeout: 20_000 });
		let reached = false;
		for (let index = 0; index < 20; index += 1) {
			await page.keyboard.press('Tab');
			reached = await page.evaluate(() => {
				const active = document.activeElement;
				return active instanceof HTMLAnchorElement && active.textContent?.includes('返回相册');
			});
			if (reached) break;
		}
		expect(reached).toBe(true);
	});
});
