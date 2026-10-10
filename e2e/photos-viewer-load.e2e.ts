import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * T10/T16 acceptance (plan §4.5, C batch): the loading-strategy branches on
 * the page viewer — ≤8MB auto-loads the full variant without a click,
 * over-threshold sources show a load button and stay idle until clicked,
 * and a saveData signal forces the same on-demand path for small files.
 * Fixture dates stay below 2030: photos-public.e2e.ts relies on its
 * 2030-01 fixtures being the NEWEST visible rows (its "no newer neighbour"
 * assertion), and specs share the live database across parallel workers.
 * The fixtures' object bytes are intentionally absent (registry-only rows),
 * so the full fetch terminates in the visible retry card — that is the
 * terminal-failure branch of T10 asserted for free. A separate client spec
 * covers the streamed success path with a stubbed fetch.
 */
const FIX = 'e2e-vload';

const FILE_SMALL = '00000000-0000-7000-9001-0000000000c1';
const FILE_BIG = '00000000-0000-7000-9001-0000000000c2';

function cleanup(): void {
	psql(`delete from photos where slug like '${FIX}%'`);
	psql(`delete from files where file_name like '${FIX}%'`);
}

function seed(): void {
	psql(
		`insert into files (id, object_key, content_hash, file_name, mime_type, byte_size, width, height, status) values
		 ('${FILE_SMALL}', 'e2/${FIX}-small.jpg', '${FIX}-hash-s', '${FIX}-small.jpg', 'image/jpeg', 1200, 4000, 3000, 'attached'),
		 ('${FILE_BIG}', 'e2/${FIX}-big.jpg', '${FIX}-hash-b', '${FIX}-big.jpg', 'image/jpeg', 20000000, 8000, 6000, 'attached')`
	);
	psql(
		`insert into photos (file_id, slug, taken_at, is_visible) values
		 ('${FILE_SMALL}', '${FIX}-small', '2029-02-02T08:00:00+08', true),
		 ('${FILE_BIG}', '${FIX}-big', '2029-02-01T08:00:00+08', true)`
	);
}

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

function trackFullRequests(page: import('@playwright/test').Page): string[] {
	const hits: string[] = [];
	page.on('request', (request) => {
		if (/(?:@|%40)full/.test(request.url())) hits.push(request.url());
	});
	return hits;
}

test.describe('photos viewer loading strategy', () => {
	test('small source auto-loads the full variant (no click) and surfaces the failure retry', async ({
		page
	}) => {
		const hits = trackFullRequests(page);
		await page.goto(`/zh-cn/photos/${FIX}-small`);
		// The detail image carries the loading-phase marker.
		const image = page.locator('.photos-viewer-image');
		await expect(image).toBeVisible({ timeout: 20_000 });
		// Auto path: the full fetch fires without any interaction.
		await expect.poll(() => hits.length, { timeout: 15_000 }).toBeGreaterThan(0);
		// The fixture's bytes are absent → terminal failure with retry (T10).
		await expect(page.locator('.photos-viewer-retry')).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('.photos-viewer-progress')).toContainText('原图加载失败');
	});

	test('over-threshold source waits for an explicit click', async ({ page }) => {
		const hits = trackFullRequests(page);
		await page.goto(`/zh-cn/photos/${FIX}-big`);
		const button = page.locator('.photos-viewer-load');
		await expect(button).toBeVisible({ timeout: 20_000 });
		await expect(button).toContainText('加载原图');
		// Settle window: nothing may be fetched behind the button.
		await page.waitForTimeout(800);
		expect(hits).toHaveLength(0);

		await button.click();
		await expect.poll(() => hits.length, { timeout: 15_000 }).toBeGreaterThan(0);
	});

	test('saveData forces on-demand even for a small source', async ({ page }) => {
		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'connection', {
				configurable: true,
				value: { saveData: true }
			});
		});
		const hits = trackFullRequests(page);
		await page.goto(`/zh-cn/photos/${FIX}-small`);
		await expect(page.locator('.photos-viewer-load')).toBeVisible({ timeout: 20_000 });
		await page.waitForTimeout(800);
		expect(hits).toHaveLength(0);
	});
});
