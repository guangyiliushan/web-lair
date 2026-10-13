import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * T11 for the overlay viewer v1.1 (plan §5.3; the carry-over items split out
 * of the page-style delivery on 2026-10-10): open via figure click and via
 * the labelled button, Esc close with FOCUS RETURN to the trigger, arrow
 * cycling with counter/URL shallow-sync and post-close page re-sync,
 * +/-/0 keyboard zoom, backdrop-vs-image click semantics, thumb-only
 * neighbour prefetch, and the axe/2.5.8 gates applied to the open overlay.
 * Fixture dates (2029-06-01..03) stay clear of every other spec's rows
 * (a11y 2029-03, viewer-load 2029-02, public 2030-01): photos-public's
 * "no newer neighbour" assertion needs its 2030-01 rows to remain newest,
 * and the mid fixture's neighbours must be exactly the two seeded siblings.
 * Fixture bytes are REAL small GIFs in RustFS (GIF = single object, no
 * variant tiers, so one key serves both the page thumb and the overlay
 * "full" fetch; keys satisfy KEY_PATTERN's dir backreference). The bytes are
 * published by `scripts/e2e-overlay-fixtures.ts` (re-run it after a bucket
 * wipe; without them test 1's blob swap and the click-geometry assertions
 * fail). Without real bytes the browser lays out the broken
 * <img> at full stage size (attrs make both dimensions definite → the
 * max-h/max-w clamps inflate instead of preserving ratio), which would make
 * "click the image" indistinguishable from the backdrop.
 */
const FIX = 'e2e-vov';

const FILE_TOWN = '00000000-0000-7000-9003-0000000000e1';
const FILE_MID = '00000000-0000-7000-9003-0000000000e2';
const FILE_OLD = '00000000-0000-7000-9003-0000000000e3';

const KEY_NEW = `ab/ab${'1'.repeat(62)}.gif`;
const KEY_MID = `ab/ab${'2'.repeat(62)}.gif`;
const KEY_OLD = `ab/ab${'3'.repeat(62)}.gif`;

function cleanup(): void {
	psql(`delete from photos where slug like '${FIX}%'`);
	psql(`delete from files where file_name like '${FIX}%'`);
}

function seed(): void {
	psql(
		`insert into files (id, object_key, content_hash, file_name, mime_type, byte_size, width, height, status) values
		 ('${FILE_TOWN}', '${KEY_NEW}', '${FIX}-hash-n', '${FIX}-new.gif', 'image/gif', 1149, 800, 600, 'attached'),
		 ('${FILE_MID}', '${KEY_MID}', '${FIX}-hash-m', '${FIX}-mid.gif', 'image/gif', 1149, 800, 600, 'attached'),
		 ('${FILE_OLD}', '${KEY_OLD}', '${FIX}-hash-o', '${FIX}-old.gif', 'image/gif', 1149, 800, 600, 'attached')`
	);
	psql(
		`insert into photos (file_id, slug, title, taken_at, is_visible) values
		 ('${FILE_TOWN}', '${FIX}-new', '{"zh-cn":"新图"}', '2029-06-03T08:00:00+08', true),
		 ('${FILE_MID}', '${FIX}-mid', '{"zh-cn":"中间图"}', '2029-06-02T08:00:00+08', true),
		 ('${FILE_OLD}', '${FIX}-old', '{"zh-cn":"旧图"}', '2029-06-01T08:00:00+08', true)`
	);
}

/** The seeded window belongs to this spec alone (fixture-domain assertion). */
function assertFixtureDomain(): void {
	const foreign = psql(
		`select count(*) from photos where is_visible
		 and coalesce(taken_at, created_at) between '2029-05-31' and '2029-06-10'
		 and slug not like '${FIX}%'`
	);
	expect(Number(foreign)).toBe(0);
}

/**
 * Live 1-based feed position of a slug (newest first), the「i / N」counter's
 * expected value - computed per poll because every spec shares the database
 * and parallel workers change the total while we watch.
 */
function expectedCounter(slug: string): string {
	const index =
		Number(
			psql(
				`select count(*) from photos where is_visible
				 and (coalesce(taken_at, created_at), id) >
				 (select coalesce(taken_at, created_at), id from photos where slug = '${slug}')`
			)
		) + 1;
	const total = Number(psql(`select count(*) from photos where is_visible`));
	return `${index} / ${total}`;
}

const CRITICAL = (violations: Array<{ impact?: string | null }>) =>
	violations.filter((violation) => violation.impact === 'critical');

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use(zhCnLocale);

test.beforeEach(() => {
	cleanup();
	seed();
	assertFixtureDomain();
});

// Symmetric cleanup: fixtures never outlive their test (house pattern).
test.afterEach(() => {
	cleanup();
});

test.afterAll(() => {
	cleanup();
});

test.describe('overlay viewer v1.1 (T11)', () => {
	test('figure click opens the overlay, prefetches the neighbour thumb, close button closes', async ({
		page
	}) => {
		await page.goto(`/zh-cn/photos/${FIX}-mid`);
		await expect(page.locator('.photos-viewer-image')).toBeVisible({ timeout: 20_000 });
		const prefetch = page.waitForRequest((request) => request.url().includes(KEY_NEW), {
			timeout: 15_000
		});
		await page.locator('figure').click({ position: { x: 140, y: 120 } });
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
		await prefetch; // Q13: +-1 neighbours warm thumb+preview on open
		await expect(page.locator('[data-photos-viewer-caption]')).toHaveText('中间图');
		await expect
			.poll(() => page.locator('[data-photos-viewer-counter]').textContent())
			.toBe(expectedCounter(`${FIX}-mid`));
		// The streamed full variant swaps in as a blob (T10 policy in the overlay).
		await expect
			.poll(
				() =>
					page
						.locator('[data-photos-viewer-stage] img')
						.evaluate((el) => (el as HTMLImageElement).src.startsWith('blob:')),
				{ timeout: 15_000 }
			)
			.toBe(true);
		await page.getByRole('button', { name: '关闭查看器' }).click();
		await expect(page.getByRole('dialog')).toBeHidden();
	});

	test('the view-larger button opens; Esc closes and returns focus to the trigger', async ({
		page
	}) => {
		await page.goto(`/zh-cn/photos/${FIX}-mid`);
		const trigger = page.getByRole('button', { name: '查看大图' });
		await expect(trigger).toBeVisible({ timeout: 20_000 });
		await trigger.click();
		await expect(page.getByRole('dialog')).toBeVisible();
		// Initial focus lands on the close button (predictable immediate exit).
		await expect
			.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
			.toBe('关闭查看器');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeHidden();
		// T11 carry-over clause: focus goes back to the element that opened it.
		await expect
			.poll(() =>
				page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim())
			)
			.toBe('查看大图');
	});

	test('arrow keys cycle neighbours, shallow-sync the URL, and closing re-syncs the page', async ({
		page
	}) => {
		await page.goto(`/zh-cn/photos/${FIX}-mid`);
		await page.getByRole('button', { name: '查看大图' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		const caption = page.locator('[data-photos-viewer-caption]');
		const counter = page.locator('[data-photos-viewer-counter]');

		await page.keyboard.press('ArrowRight'); // older
		await expect(caption).toHaveText('旧图');
		await expect.poll(() => page.url()).toContain(`/zh-cn/photos/${FIX}-old`);
		await expect.poll(() => counter.textContent()).toBe(expectedCounter(`${FIX}-old`));

		await page.keyboard.press('ArrowLeft'); // newer, back to the middle
		await expect(caption).toHaveText('中间图');
		await expect.poll(() => page.url()).toContain(`/zh-cn/photos/${FIX}-mid`);
		await expect.poll(() => counter.textContent()).toBe(expectedCounter(`${FIX}-mid`));

		await page.keyboard.press('ArrowRight'); // leave on the older sibling
		await expect(caption).toHaveText('旧图');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeHidden();
		// The page re-syncs to the navigated slug (replaceState goto): the URL
		// already points at it and the SSR content follows.
		await expect.poll(() => page.url()).toContain(`/zh-cn/photos/${FIX}-old`);
		await expect
			.poll(async () =>
				(await page.locator('h1').allTextContents()).some((t) => t.includes('旧图'))
			)
			.toBe(true);
	});

	test('keyboard zoom drives the overlay image transform; 0 resets', async ({ page }) => {
		await page.goto(`/zh-cn/photos/${FIX}-mid`);
		await page.getByRole('button', { name: '查看大图' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		const overlayImage = page.locator('[data-photos-viewer-stage] img');
		await expect
			.poll(() => overlayImage.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
				timeout: 15_000
			})
			.toBeGreaterThan(0);
		await page.keyboard.press('+');
		await expect
			.poll(() => overlayImage.evaluate((el) => el.style.transform))
			.toContain('scale(1.5)');
		await page.keyboard.press('-');
		await expect
			.poll(() => overlayImage.evaluate((el) => el.style.transform))
			.toContain('scale(1)');
		await page.keyboard.press('+');
		await expect
			.poll(() => overlayImage.evaluate((el) => el.style.transform))
			.toContain('scale(1.5)');
		await page.keyboard.press('0');
		await expect
			.poll(() => overlayImage.evaluate((el) => el.style.transform))
			.toContain('scale(1)');
	});

	test('backdrop click closes; clicking the image does not', async ({ page }) => {
		await page.goto(`/zh-cn/photos/${FIX}-mid`);
		await page.getByRole('button', { name: '查看大图' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		const overlayImage = page.locator('[data-photos-viewer-stage] img');
		await expect
			.poll(() => overlayImage.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
				timeout: 15_000
			})
			.toBeGreaterThan(0);
		await overlayImage.click({ position: { x: 5, y: 5 } });
		await expect(page.getByRole('dialog')).toBeVisible();
		// The stage top-left corner is backdrop (image is centred, controls
		// live in the corners/bars).
		await page.locator('[data-photos-viewer-stage]').click({ position: { x: 8, y: 8 } });
		await expect(page.getByRole('dialog')).toBeHidden();
	});

	test('overlay open: zero critical axe violations; controls meet 24x24', async ({ page }) => {
		await page.goto(`/zh-cn/photos/${FIX}-mid`);
		await page.getByRole('button', { name: '查看大图' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		const results = await new AxeBuilder({ page }).analyze();
		const summary = results.violations.map(
			(violation) => `${violation.impact}: ${violation.id} (${violation.nodes.length})`
		);
		if (summary.length > 0) console.log('[axe:overlay]', summary.join(' | '));
		expect(CRITICAL(results.violations), JSON.stringify(summary)).toEqual([]);
		for (const control of [
			page.getByRole('button', { name: '关闭查看器' }),
			page.getByRole('button', { name: '上一张' }),
			page.getByRole('button', { name: '下一张' })
		]) {
			const box = await control.boundingBox();
			expect(box, 'control missing').not.toBeNull();
			expect(box!.width).toBeGreaterThanOrEqual(24);
			expect(box!.height).toBeGreaterThanOrEqual(24);
		}
	});
});
