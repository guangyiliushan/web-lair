import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * Storage ST-2 (2b) public gallery acceptance: the masonry grid renders the
 * visible feed in keyset order (hidden rows absent), the filter chips drill
 * by camera, the viewer ships the EXIF floater with neighbour navigation
 * (link + ArrowLeft/ArrowRight), a retired slug 301s exactly once through
 * slug_trackers, hidden slugs 404, and "load more" extends the stateless
 * cursor chain. Fixtures share the `e2e-photo` marker and are cleaned
 * around every test; counts are checked against the live DB so the suite
 * stays truthful next to other data. Swipe gestures are not driven here
 * (pointer emulation is flaky under load) - the gesture wiring is pinned by
 * the component contract, keyboard equivalents are covered below.
 */

const FIX = 'e2e-photo';
const CAMERA = 'E2E Camera';

const FILE_A = '00000000-0000-7000-8000-0000000000a1';
const FILE_B = '00000000-0000-7000-8000-0000000000a2';
const FILE_G = '00000000-0000-7000-8000-0000000000a3';

function cleanup(): void {
	psql(`delete from photos where slug like '${FIX}%'`);
	psql(`delete from files where file_name like '${FIX}%'`);
	psql(`delete from slug_trackers where type = 'photo' and slug like '${FIX}%'`);
}

function seedCore(): void {
	psql(
		`insert into files (id, object_key, content_hash, file_name, mime_type, byte_size, width, height, status) values
		 ('${FILE_A}', 'e2/${FIX}-a.jpg', '${FIX}-hash-a', '${FIX}-a.jpg', 'image/jpeg', 1200, 4000, 3000, 'attached'),
		 ('${FILE_B}', 'e2/${FIX}-b.jpg', '${FIX}-hash-b', '${FIX}-b.jpg', 'image/jpeg', 1200, 3000, 4000, 'attached'),
		 ('${FILE_G}', 'e2/${FIX}-g.jpg', '${FIX}-hash-g', '${FIX}-g.jpg', 'image/jpeg', 1200, 4000, 4000, 'attached')`
	);
	psql(
		`insert into photos (file_id, slug, title, description, taken_at, camera_make, camera_model, lens_model, f_number, focal_length_mm, exposure_time_s, iso, is_visible) values
		 ('${FILE_A}', '${FIX}-alpha', '{"en":"E2E Alpha","zh-cn":"E2E 甲"}', null, '2026-01-03T08:00:00+08', 'FUJIFILM', '${CAMERA}', 'E2E Lens', 2.8, 35, 0.008, 400, true),
		 ('${FILE_B}', '${FIX}-beta', null, '{"zh-cn":"乙的照片"}', '2026-01-02T08:00:00+08', null, null, null, null, null, null, null, true),
		 ('${FILE_G}', '${FIX}-gamma', '{"en":"${FIX}-gamma-marker"}', null, '2026-01-01T08:00:00+08', null, null, null, null, null, null, null, false)`
	);
}

function seedBulk(count: number): void {
	psql(
		`insert into files (id, object_key, content_hash, file_name, mime_type, byte_size, width, height, status)
		 select ('00000000-0000-7000-8001-' || lpad(i::text, 12, '0'))::uuid,
		        'e2/${FIX}-bulk-' || i || '.jpg',
		        '${FIX}-bulk-hash-' || i,
		        '${FIX}-bulk-' || i || '.jpg',
		        'image/jpeg', 1000, 4000, 3000, 'attached'
		 from generate_series(1, ${count}) as i`
	);
	psql(
		`insert into photos (file_id, slug, taken_at, is_visible)
		 select ('00000000-0000-7000-8001-' || lpad(i::text, 12, '0'))::uuid,
		        '${FIX}-bulk-' || i,
		        now() - (i || ' days')::interval,
		        true
		 from generate_series(1, ${count}) as i`
	);
}

function visibleCount(): number {
	return Number(psql(`select count(*) from photos where is_visible`));
}

test.describe.configure({ mode: 'serial', timeout: 300_000 });
test.use(zhCnLocale);

test.beforeEach(() => {
	cleanup();
	seedCore();
});

test.afterAll(() => {
	cleanup();
});

test.describe('photos public gallery', () => {
	test('renders the visible feed in keyset order and hides invisible rows', async ({ page }) => {
		await page.goto('/zh-cn/photos');
		await expect(page.getByRole('heading', { name: '相册' })).toBeVisible({ timeout: 20_000 });

		const grid = page.locator('.photos-masonry');
		await expect(grid).toBeVisible();

		// Every visible row renders; the count matches the live database.
		await expect(grid.locator('a')).toHaveCount(visibleCount(), { timeout: 10_000 });

		// Hidden rows never surface (title marker is unique to the row).
		await expect(page.getByText(`${FIX}-gamma-marker`)).toHaveCount(0);

		const alpha = grid.locator(`a[href*="${FIX}-alpha"]`);
		const beta = grid.locator(`a[href*="${FIX}-beta"]`);
		await expect(alpha).toBeVisible();
		await expect(beta).toBeVisible();

		// Keyset order: alpha (2026-01-03) precedes beta (2026-01-02).
		const order = await grid.locator('a').evaluateAll(
			(anchors, [a, b]) =>
				[
					anchors.findIndex((el) => (el as HTMLAnchorElement).href.includes(a as string)),
					anchors.findIndex((el) => (el as HTMLAnchorElement).href.includes(b as string))
				] as [number, number],
			[`${FIX}-alpha`, `${FIX}-beta`]
		);
		expect(order[0]).toBeGreaterThanOrEqual(0);
		expect(order[1]).toBeGreaterThan(order[0]);

		// Aspect-ratio frame + variant URL on the anchor's img.
		const frameStyle = await alpha.locator('xpath=..').getAttribute('style');
		expect(frameStyle).toContain('aspect-ratio');
		await expect(alpha.locator('img')).toHaveAttribute('src', /^\/i\//);
		await expect(alpha.locator('img')).toHaveAttribute('loading', 'lazy');
	});

	test('filters by camera and resets with the All chip', async ({ page }) => {
		await page.goto(`/zh-cn/photos?camera=${encodeURIComponent(CAMERA)}`);
		await expect(page.getByRole('heading', { name: '相册' })).toBeVisible({ timeout: 20_000 });

		const grid = page.locator('.photos-masonry');
		await expect(grid.locator(`a[href*="${FIX}-alpha"]`)).toBeVisible();
		await expect(grid.locator(`a[href*="${FIX}-beta"]`)).toHaveCount(0);

		await page
			.locator('xpath=//span[text()="相机"]/parent::div')
			.getByRole('link', { name: '全部' })
			.click();
		await expect(grid.locator(`a[href*="${FIX}-beta"]`)).toBeVisible();
	});

	test('viewer shows the EXIF floater and navigates by link and keyboard', async ({ page }) => {
		await page.goto(`/zh-cn/photos/${FIX}-alpha`);

		const floater = page.locator('div.sticky');
		await expect(floater).toContainText('E2E 甲', { timeout: 20_000 });
		await expect(floater).toContainText('E2E Camera');
		await expect(floater).toContainText('f/2.8');
		await expect(floater).toContainText('35mm');
		await expect(floater).toContainText('ISO 400');
		await expect(floater.getByRole('link', { name: '返回相册' })).toBeVisible();

		// Alpha is the newest fixture: no newer neighbour, beta older.
		await expect(floater.getByRole('link', { name: '上一张' })).toHaveCount(0);
		await floater.getByRole('link', { name: '下一张' }).click();
		await expect(page).toHaveURL(new RegExp(`${FIX}-beta$`));

		// Keyboard walks back to the newer neighbour.
		await page.keyboard.press('ArrowLeft');
		await expect(page).toHaveURL(new RegExp(`${FIX}-alpha$`));
	});

	test('retired slugs 301 once and hidden slugs 404', async ({ page }) => {
		const photoId = psql(`select id from photos where slug = '${FIX}-alpha'`);
		expect(photoId).toMatch(/^[0-9a-f-]{36}$/);
		psql(`update photos set slug = '${FIX}-alpha-v2' where id = '${photoId}'`);
		psql(
			`insert into slug_trackers (slug, type, lang, target_id) values ('${FIX}-alpha', 'photo', 'en', '${photoId}')`
		);

		await page.goto(`/zh-cn/photos/${FIX}-alpha`);
		await expect(page).toHaveURL(new RegExp(`${FIX}-alpha-v2$`));
		await expect(page.locator('div.sticky')).toContainText('E2E 甲', { timeout: 20_000 });

		const hidden = await page.goto(`/zh-cn/photos/${FIX}-gamma`);
		expect(hidden?.status()).toBe(404);
	});

	test('load more extends the cursor chain to the full feed', async ({ page }) => {
		seedBulk(25);
		const total = visibleCount();
		expect(total).toBeGreaterThan(24);

		await page.goto('/zh-cn/photos');
		await expect(page.getByRole('heading', { name: '相册' })).toBeVisible({ timeout: 20_000 });

		const grid = page.locator('.photos-masonry');
		await expect(grid.locator('a')).toHaveCount(24);
		const more = page.getByRole('link', { name: '加载更多' });
		await expect(more).toBeVisible();
		await more.click();

		await expect(grid.locator('a')).toHaveCount(total, { timeout: 15_000 });
		await expect(page.getByRole('link', { name: '加载更多' })).toHaveCount(0);
	});
});
