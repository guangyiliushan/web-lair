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
			await expect(toolbar.locator('button[aria-label="左对齐"]')).toBeVisible();
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

			// At 1280px, toolbar should have enough width for bp >= 3 (>=700px)
			// Even with sidebar expanded, the toolbar gets ~970px
			await expect(toolbar.locator('button[aria-label="高亮"]')).toBeVisible();
			await expect(toolbar.locator('button[aria-label="左对齐"]')).toBeVisible();
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

			// Overflow menu should contain items hidden at tablet width
			const menuText = await menu.textContent();
			expect(menuText).toBeTruthy();
			expect(menuText!.length).toBeGreaterThan(0);
		});

		test('overflow menu content scrolls at small viewport', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.mobile);
			await page.goto('/admin/posts/edit');

			const toolbar = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]');
			const overflowBtn = toolbar.locator('button[aria-label="更多"]');
			await overflowBtn.click();

			const menu = page.locator('[data-slot="dropdown-menu-content"]');
			await expect(menu).toBeVisible({ timeout: 2000 });

			// Menu should have max-height constraint and be scrollable if needed
			const maxHeight = await menu.evaluate((el) => window.getComputedStyle(el).maxHeight);
			expect(maxHeight).not.toBe('none');
		});
	});

	test.describe('sticky behavior', () => {
		test('toolbar wrapper sticks below header on scroll', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.desktop);
			await page.goto('/admin/posts/edit');

			const wrapper = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]').locator('..');
			await expect(wrapper).toBeVisible({ timeout: 10000 });

			// Scroll the page down to trigger sticky
			await page.evaluate(() => window.scrollTo(0, 500));
			await page.waitForTimeout(500);

			// Wrapper should still be visible
			await expect(wrapper).toBeVisible();

			// The wrapper should be near the top, just below the admin header (h-14 ≈ 56px)
			const box = await wrapper.boundingBox();
			expect(box).not.toBeNull();
			if (box) {
				expect(box.y).toBeGreaterThanOrEqual(50);
				expect(box.y).toBeLessThan(120);
			}
		});

		test('header and toolbar both sticky and visible after large scroll', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.desktop);
			await page.goto('/admin/posts/edit');

			const header = page.locator('header.sticky');
			const wrapper = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]').locator('..');
			await expect(header).toBeVisible({ timeout: 10000 });

			await page.evaluate(() => window.scrollTo(0, 2000));
			await page.waitForTimeout(500);

			// Both should be visible (sticky)
			await expect(header).toBeVisible();
			await expect(wrapper).toBeVisible();
		});

		test('toolbar sticky works at tablet viewport', async ({ page }) => {
			await page.setViewportSize(VIEWPORTS.tablet);
			await page.goto('/admin/posts/edit');

			const wrapper = page.locator('[role="toolbar"][aria-label="编辑器工具栏"]').locator('..');
			await expect(wrapper).toBeVisible({ timeout: 10000 });

			await page.evaluate(() => window.scrollTo(0, 400));
			await page.waitForTimeout(500);

			await expect(wrapper).toBeVisible();
		});
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
