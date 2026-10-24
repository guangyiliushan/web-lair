import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import {
	NAV_COL_PRIMARY_W,
	NAV_COL_SECONDARY_W,
	NAV_HOME_GRID_MAX,
	NAV_PANEL_HEIGHT
} from '../src/lib/components/layout/nav-menu/geometry';
import { expectNoCriticalAxe } from './support';

/**
 * micro-content C2 acceptance (roadmap #7): the renamed / added public routes
 * (quotes / thoughts / moments), the retired ones (says / thinking → 404),
 * the header wiring (微记 in the old 思考 slot, 摘录 / 思考 inside the "more"
 * menu) and the admin sidebar trio. The content pages are empty placeholders
 * shipped by C2 — C3 fills their UI, so only reachability and the chrome
 * links are pinned here.
 */

test.use(zhCnLocale);

test.describe('micro C2 routes', () => {
	test('renamed and new content routes answer 200 under the locale prefix', async ({ page }) => {
		for (const path of ['/zh-cn/quotes', '/zh-cn/thoughts', '/zh-cn/moments']) {
			const response = await page.goto(path);
			expect(response?.status(), path).toBe(200);
		}
	});

	test('retired routes answer 404', async ({ page }) => {
		for (const path of ['/zh-cn/says', '/zh-cn/thinking']) {
			const response = await page.goto(path);
			expect(response?.status(), path).toBe(404);
		}
	});

	test('bare paths redirect to the localized route (307)', async ({ page }) => {
		for (const path of ['/quotes', '/thoughts', '/moments']) {
			await page.goto(path);
			expect(new URL(page.url()).pathname, path).toBe(`/zh-cn${path}`);
		}
	});
});

test.describe('micro C2 navigation', () => {
	test('top nav links 微记 to the localized moments route', async ({ page }) => {
		await page.goto('/');
		const nav = page.getByRole('navigation', { name: 'Main navigation' });
		const moments = nav.getByRole('link', { name: '微记' });
		await expect(moments).toBeVisible();
		await expect(moments).toHaveAttribute('href', '/zh-cn/moments');
	});

	test('the more menu carries 摘录 / 思考 with localized hrefs', async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/');
		const nav = page.getByRole('navigation', { name: 'Main navigation' });
		const trigger = nav.getByRole('button', { name: '更多' });
		// The panel lives inside the header nav now (no portal), so it is
		// scoped by `data-slot` rather than by role: the trigger and the panel
		// rows can share accessible names, and `role="menu"` is gone.
		const panel = page.locator('[data-slot="navigation-menu-content"]');
		// Leave-then-re-enter: a hover() with the pointer already on the element
		// never re-fires mouseenter, so plain retries would be no-ops (repo lesson).
		await expect(async () => {
			await page.mouse.move(0, 0);
			await trigger.hover();
			await expect(panel.getByRole('link', { name: /摘录/ })).toBeVisible({
				timeout: 3000
			});
		}).toPass({ timeout: 20_000 });
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect(panel.getByRole('link', { name: /摘录/ })).toHaveAttribute(
			'href',
			'/zh-cn/quotes'
		);
		await expect(panel.getByRole('link', { name: /思考/ })).toHaveAttribute(
			'href',
			'/zh-cn/thoughts'
		);
		// D2: the panel is site navigation now — axe must stay clean with it open.
		await expectNoCriticalAxe(page, 'nav-panel-open');
	});

	test('the two-column panel keeps both columns at working width', async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/');
		const nav = page.getByRole('navigation', { name: 'Main navigation' });
		const trigger = nav
			.getByRole('link', { name: '文章' })
			.and(page.locator('[aria-haspopup="true"]'));
		const panel = page.locator('[data-slot="navigation-menu-content"]');
		await expect(async () => {
			await page.mouse.move(0, 0);
			await trigger.hover();
			await expect(panel).toBeVisible({ timeout: 3000 });
		}).toPass({ timeout: 20_000 });

		// The vendored content class ends in `md:absolute md:w-auto`; a media-query
		// rule outranks an unprefixed `w-[520px]`, so the panel collapsed to content
		// width and the `1fr` right column fell to ~0 — visible as a "broken"
		// second column that rendered nothing. Width now lives on the panel div.
		const box = await panel.locator('[data-slot="nav-menu-panel"]').boundingBox();
		expect(box, 'panel box').not.toBeNull();
		expect(box!.width, 'panel keeps its configured width').toBeGreaterThanOrEqual(500);
		expect(Math.round(box!.height), 'panel height').toBe(NAV_PANEL_HEIGHT);

		// Both columns follow the shared geometry: a per-panel split makes the
		// divider jump as the pointer moves between nav items.
		const primary = panel.locator('[data-slot="nav-menu-col-primary"]');
		await expect(primary).toBeVisible();
		const left = await primary.boundingBox();
		expect(left, 'primary column box').not.toBeNull();
		expect(Math.round(left!.width), 'primary column width').toBe(NAV_COL_PRIMARY_W);

		const secondary = panel.locator('[data-slot="nav-menu-col-secondary"]');
		await expect(secondary).toBeVisible();
		const col = await secondary.boundingBox();
		expect(col, 'secondary column box').not.toBeNull();
		expect(col!.width, 'the 1fr column must not collapse').toBeGreaterThanOrEqual(250);
		expect(Math.round(col!.width), 'secondary column takes the remainder').toBe(
			NAV_COL_SECONDARY_W
		);
		await expect(secondary.getByRole('link').first()).toBeVisible();
	});

	test('the home panel holds the shared height and caps its page grid', async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/');
		const nav = page.getByRole('navigation', { name: 'Main navigation' });
		const trigger = nav
			.getByRole('link', { name: '首页' })
			.and(page.locator('[aria-haspopup="true"]'));
		const panel = page.locator('[data-slot="navigation-menu-content"]');
		await expect(async () => {
			await page.mouse.move(0, 0);
			await trigger.hover();
			await expect(panel).toBeVisible({ timeout: 3000 });
		}).toPass({ timeout: 20_000 });

		// Every panel is pinned to the same height so it does not resize as the
		// pointer moves between nav items (H4). The home panel is the baseline.
		const box = await panel.locator('[data-slot="nav-menu-panel"]').boundingBox();
		expect(box, 'panel box').not.toBeNull();
		expect(Math.round(box!.height), 'panel height').toBe(NAV_PANEL_HEIGHT);

		// H3: fixed slot count. Unbounded, a registry with many pages would push
		// the grid past the shared height and get clipped by `overflow-hidden`.
		const links = panel.locator('[data-slot="nav-menu-pages"] a');
		expect(await links.count(), 'page grid cap').toBeLessThanOrEqual(NAV_HOME_GRID_MAX);
	});

	test('admin sidebar links 摘录 / 思考 / 微记 to the renamed routes', async ({ page }) => {
		await page.goto('/admin');
		await expect(page.getByRole('link', { name: '摘录' })).toHaveAttribute('href', '/admin/quotes');
		await expect(page.getByRole('link', { name: '思考' })).toHaveAttribute(
			'href',
			'/admin/thoughts'
		);
		await expect(page.getByRole('link', { name: '微记' })).toHaveAttribute(
			'href',
			'/admin/moments'
		);
	});

	test('public friends page renders its link cards and status sections', async ({ page }) => {
		await page.goto('/en/friends');

		await expect(page.getByRole('heading', { name: 'Friends' }).first()).toBeVisible();
		await expect(page.getByRole('link', { name: /Web Lair/ })).toBeVisible();
		await expect(page.getByText('Unreachable sites')).toBeVisible();
		await expect(page.getByText('Non-compliant sites')).toBeVisible();
	});

	test('dashboard quick actions carry the five micro cards', async ({ page }) => {
		await page.goto('/admin');
		const quick = page.locator('section', { hasText: '快速操作' }).first();
		for (const title of ['文章', '手记', '摘录', '思考', '微记']) {
			await expect(quick.getByText(title, { exact: true })).toBeVisible();
		}
		await expect(quick.locator('a[href="/admin/moments"]').first()).toBeVisible();
	});
});
