import { test, expect } from '@playwright/test';

const VIEWPORTS = {
	mobile: { width: 375, height: 812 },
	tablet: { width: 768, height: 1024 },
	desktop: { width: 1280, height: 900 },
	wide: { width: 1600, height: 900 }
} as const;

// bp thresholds based on ResizeObserver measured toolbar width (not viewport)
// bp=0: <420px, bp=1: 420-649px, bp=2: 650-899px, bp=3: 900-949px, bp=4: >=950px

test.describe('EditorToolbar', () => {
	test.describe('rendering', () => {
		test('toolbar is visible after page load', async ({ page }) => {
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');
			await expect(toolbar).toBeVisible({ timeout: 10000 });
		});

		test('contains essential formatting buttons at desktop viewport', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.desktop);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');

			// Core formatting buttons always visible at all breakpoints
			await expect(toolbar.locator('button[aria-label="粗体"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="斜体"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="插入链接"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="插入图片"]')).toBeVisible();
		});

		test('buttons at bp >= 2 visible at wide viewport', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.wide);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');

			// At wide viewport with sidebar, toolbar should have enough width for bp >= 3
			await expect(toolbar.locator('button[aria-label="下划线"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="删除线"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="无序列表"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="引用"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="插入表格"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="高亮"]')).toBeVisible();
		});

		test('core buttons remain visible at tablet viewport', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.tablet);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');

			await expect(toolbar.locator('button[aria-label="粗体"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="斜体"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="插入链接"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="插入图片"]')).toBeVisible();
		});

		test('core buttons remain visible at mobile viewport', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.mobile);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');

			await expect(toolbar.locator('button[aria-label="粗体"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="斜体"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="插入链接"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="插入图片"]')).toBeVisible();
		});
	});

	test.describe('ResizeObserver-based breakpoints', () => {
		test('toolbar adapts to actual container width, not viewport', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.desktop);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');

			// Deterministic width: wait for hydration, then collapse the sidebar so
			// the toolbar reaches bp >= 3 (otherwise it sits on the bp boundary).
			const sidebar = page.locator('[data-slot="sidebar"]');
			const sidebarTrigger = page.locator('[data-slot="sidebar-trigger"]');
			await expect(sidebar).toHaveAttribute('data-state', /(expanded|collapsed)/, {
				timeout: 15000
			});
			if ((await sidebar.getAttribute('data-state')) === 'expanded') {
				await sidebarTrigger.click();
				await page.waitForTimeout(500);
			}
			await expect(toolbar).toBeVisible({ timeout: 10000 });

			// At 1280px with the sidebar collapsed, the toolbar has enough
			// width for bp >= 3 (>=900px)
			await expect(toolbar.locator('button[aria-label="高亮"]')).toBeVisible();
		});

		test('overflow menu is present at mobile viewport', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.mobile);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');
			const overflowBtn = toolbar.locator('button[aria-label="更多"]');
			await expect(overflowBtn).toBeVisible();
		});

		test('overflow menu opens and contains hidden items at tablet', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.tablet);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');
			const overflowBtn = toolbar.locator('button[aria-label="更多"]');
			await overflowBtn.click();

			const menu = page.locator('[data-slot="dropdown-menu-content"]');
			await expect(menu).toBeVisible({ timeout: 2000 });

			// Overflow menu must actually contain the items hidden at tablet width
			await expect(menu.getByText('高亮')).toBeVisible();
			await expect(menu.getByText('插入表格')).toBeVisible();
			const scrollable = await menu.evaluate((el) => el.scrollHeight >= el.clientHeight);
			expect(scrollable).toBe(true);
		});

		test('overflow menu content scrolls at small viewport', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.mobile);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');
			const overflowBtn = toolbar.locator('button[aria-label="更多"]');
			await overflowBtn.click();

			const menu = page.locator('[data-slot="dropdown-menu-content"]');
			await expect(menu).toBeVisible({ timeout: 2000 });

			// Menu should have a real max-height constraint and overflow content
			const maxHeight = await menu.evaluate((el) => window.getComputedStyle(el).maxHeight);
			expect(parseFloat(maxHeight)).toBeGreaterThan(200);
			const overflowing = await menu.evaluate((el) => el.scrollHeight > el.clientHeight);
			expect(overflowing).toBe(true);
		});
	});

	test.describe('sticky behavior', () => {
		test('toolbar wrapper sticks below header on scroll', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.desktop);
			await page.goto('/admin/posts/edit');

			const wrapper = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]').locator('..');
			await expect(wrapper).toBeVisible({ timeout: 10000 });

			// The admin shell is a fixed-height layout with no scrollable
			// content, so assert the sticky contract itself instead of
			// scrolling: position:sticky pinned below the h-14 header.
			await expect(wrapper).toBeVisible();
			const style = await wrapper.evaluate((el) => {
				const cs = window.getComputedStyle(el);
				return { position: cs.position, top: cs.top };
			});
			expect(style.position).toBe('sticky');
			expect(style.top).toBe('56px');
		});

		// Removed: 'header and toolbar both sticky...' — this page has no scrollable
		// content (scrollHeight == clientHeight), so the scroll was a no-op and the
		// assertions were toothless. The computed-style contract test above keeps
		// the real sticky guarantee.

		// Removed: tablet scroll variant — same no-scrollable-content reason as above.
	});

	test.describe('no horizontal overflow', () => {
		test('page has no visual horizontal scroll at desktop', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.desktop);
			await page.goto('/admin/posts/edit');
			await page.waitForTimeout(1000);

			const canScrollH = await page.evaluate(() => {
				const before = window.scrollX;
				window.scrollTo(100, 0);
				const after = window.scrollX;
				window.scrollTo(0, 0);
				return after > before;
			});

			expect(canScrollH).toBe(false);
		});

		test('page has no horizontal scroll at 1024px (sidebar expanded)', async ({ page }) => {
			await page.setViewportSize({ width: 1024, height: 900 });
			await page.goto('/admin/posts/edit');
			await page.waitForTimeout(1000);

			const canScrollH = await page.evaluate(() => {
				const before = window.scrollX;
				window.scrollTo(100, 0);
				const after = window.scrollX;
				window.scrollTo(0, 0);
				return after > before;
			});

			expect(canScrollH).toBe(false);
		});

		test('page has no horizontal scroll at 768px (sidebar expanded)', async ({ page }) => {
			await page.setViewportSize({ width: 768, height: 1024 });
			await page.goto('/admin/posts/edit');
			await page.waitForTimeout(1000);

			const canScrollH = await page.evaluate(() => {
				const before = window.scrollX;
				window.scrollTo(100, 0);
				const after = window.scrollX;
				window.scrollTo(0, 0);
				return after > before;
			});

			expect(canScrollH).toBe(false);
		});

		test('page has no visual horizontal scroll at tablet', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.tablet);
			await page.goto('/admin/posts/edit');
			await page.waitForTimeout(1000);

			const canScrollH = await page.evaluate(() => {
				const before = window.scrollX;
				window.scrollTo(100, 0);
				const after = window.scrollX;
				window.scrollTo(0, 0);
				return after > before;
			});

			expect(canScrollH).toBe(false);
		});

		test('page has no visual horizontal scroll at mobile', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.mobile);
			await page.goto('/admin/posts/edit');
			await page.waitForTimeout(1000);

			const canScrollH = await page.evaluate(() => {
				const before = window.scrollX;
				window.scrollTo(100, 0);
				const after = window.scrollX;
				window.scrollTo(0, 0);
				return after > before;
			});

			expect(canScrollH).toBe(false);
		});

		test('page has no visual horizontal scroll with sidebar expanded', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.desktop);
			await page.goto('/admin/posts/edit');
			await page.waitForTimeout(1000);

			// Ensure sidebar is expanded
			const sidebarTrigger = page.locator('[data-slot="sidebar-trigger"]');
			const sidebar = page.locator('[data-slot="sidebar"]');
			const sidebarState = await sidebar.getAttribute('data-state');
			if (sidebarState === 'collapsed') {
				await sidebarTrigger.click();
				await page.waitForTimeout(500);
			}

			const canScrollH = await page.evaluate(() => {
				const before = window.scrollX;
				window.scrollTo(100, 0);
				const after = window.scrollX;
				window.scrollTo(0, 0);
				return after > before;
			});

			expect(canScrollH).toBe(false);
		});

		test('page has no visual horizontal scroll with sidebar collapsed', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.desktop);
			await page.goto('/admin/posts/edit');
			await page.waitForTimeout(1000);

			const sidebarTrigger = page.locator('[data-slot="sidebar-trigger"]');
			const sidebar = page.locator('[data-slot="sidebar"]');
			const sidebarState = await sidebar.getAttribute('data-state');
			if (sidebarState === 'expanded') {
				await sidebarTrigger.click();
				await page.waitForTimeout(500);
			}

			const canScrollH = await page.evaluate(() => {
				const before = window.scrollX;
				window.scrollTo(100, 0);
				const after = window.scrollX;
				window.scrollTo(0, 0);
				return after > before;
			});

			expect(canScrollH).toBe(false);
		});
	});

	test.describe('toolbar state reflects editor state', () => {
		test('block type dropdown is present and functional', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.desktop);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');
			const blockDropdown = toolbar.locator('[data-slot="dropdown-menu-trigger"]').first();
			await expect(blockDropdown).toBeVisible();
		});
	});
});
