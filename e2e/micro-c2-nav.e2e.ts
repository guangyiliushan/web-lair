import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';

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
		// The mega panel renders through a portal outside the header, so its
		// menuitems are page-scoped, not nav-scoped (pages-p1b precedent).
		const panel = page.locator('[role="menu"]').first();
		// Leave-then-re-enter: a hover() with the pointer already on the element
		// never re-fires mouseenter, so plain retries would be no-ops (repo lesson).
		await expect(async () => {
			await page.mouse.move(0, 0);
			await trigger.hover();
			await expect(panel.getByRole('menuitem', { name: /摘录/ })).toBeVisible({
				timeout: 3000
			});
		}).toPass({ timeout: 20_000 });
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect(panel.getByRole('menuitem', { name: /摘录/ })).toHaveAttribute(
			'href',
			'/zh-cn/quotes'
		);
		await expect(panel.getByRole('menuitem', { name: /思考/ })).toHaveAttribute(
			'href',
			'/zh-cn/thoughts'
		);
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

	test('dashboard quick actions carry the five micro cards', async ({ page }) => {
		await page.goto('/admin');
		const quick = page.locator('section', { hasText: '快速操作' }).first();
		for (const title of ['博文', '手记', '摘录', '思考', '微记']) {
			await expect(quick.getByText(title, { exact: true })).toBeVisible();
		}
		await expect(quick.locator('a[href="/admin/moments"]').first()).toBeVisible();
	});
});
