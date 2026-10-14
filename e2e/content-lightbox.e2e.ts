import AxeBuilder from '@axe-core/playwright';
import { expect, request, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { OVERLAY_FIXTURE_KEYS } from './overlay-fixture-keys';
import { ORIGIN, psql } from './support';

/**
 * CONTENT LIGHTBOX (3d, Q4/Q14 teeth): article images inside a rendered
 * markdown page become interactive controls - click opens the shared overlay
 * viewer, Esc closes it and focus returns to the image; an absolute-URL
 * (external) image opens WITHOUT any feed chrome; images inside links keep
 * their link behavior; broken images stay plain; SSR output carries no
 * enhancement markup; axe stays at zero critical violations with the
 * controls in place.
 *
 * Fixtures: one `e2e-clbox` page whose zh-cn body references the three GIFs
 * published by `scripts/e2e-overlay-fixtures.ts` (one as a relative /i/ src,
 * one as an absolute http://localhost URL = the external branch, one inside
 * a markdown link) plus a well-formed but missing key (the broken case). No
 * new bytes are needed; a beforeAll probe skips with the fix command when
 * the bucket was wiped.
 */
const SLUG = 'e2e-clbox';

const { new: KEY_EXTERNAL, mid: KEY_INTERNAL, old: KEY_LINKED } = OVERLAY_FIXTURE_KEYS;
const KEY_BROKEN = `ab/ab${'0'.repeat(62)}.png`;

const BODY = [
	`![正文 GIF](/i/${KEY_INTERNAL})`,
	'',
	`![外链 GIF](${ORIGIN}/i/${KEY_EXTERNAL})`,
	'',
	`[![链接图](${ORIGIN}/i/${KEY_LINKED})](#clbox-anchor)`,
	'',
	`![坏图](/i/${KEY_BROKEN}@full)`
].join('\n');

function cleanup(): void {
	psql(`delete from pages where slug = '${SLUG}'`);
}

function seed(): void {
	const content = JSON.stringify({ 'zh-cn': BODY }).replace(/'/g, "''");
	psql(
		`insert into pages (slug, title, content, content_format, status, sort_order, is_default) values ('${SLUG}', '{"zh-cn":"E2E 光箱页"}'::jsonb, '${content}'::jsonb, 'markdown', 'visible', 0, false)`
	);
}

let fixtureBytesReady = false;

test.beforeAll(async () => {
	cleanup();
	seed();
	const context = await request.newContext({ baseURL: ORIGIN });
	try {
		const probe = await context.get(`/i/${KEY_INTERNAL}`);
		fixtureBytesReady = probe.ok();
	} catch {
		fixtureBytesReady = false;
	} finally {
		await context.dispose();
	}
	if (!fixtureBytesReady) {
		console.warn('fixture bytes missing - run `pnpm e2e:overlay-fixtures`');
	}
});

test.afterAll(() => {
	cleanup();
});

function requireBytes(): void {
	test.skip(!fixtureBytesReady, 'fixture bytes missing - run `pnpm e2e:overlay-fixtures`');
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.use(zhCnLocale);

test.describe('content lightbox (3d)', () => {
	test('an article image opens the overlay; Esc returns focus to the image', async ({ page }) => {
		requireBytes();
		await page.goto(`/zh-cn/${SLUG}`);
		const control = page.getByRole('button', { name: '查看大图：正文 GIF' });
		await expect(control).toBeVisible({ timeout: 20_000 });
		await control.click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.locator('[data-photos-viewer-caption]')).toHaveText('正文 GIF');
		// GIF bare key: displayed frame IS the full image (no upgrade fetch).
		const stageImage = page.locator('[data-photos-viewer-stage] img');
		await expect(stageImage).toHaveAttribute('src', new RegExp(KEY_INTERNAL));
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeHidden();
		await expect
			.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
			.toBe('查看大图：正文 GIF');
	});

	test('an absolute-URL image opens without feed chrome', async ({ page }) => {
		requireBytes();
		await page.goto(`/zh-cn/${SLUG}`);
		const control = page.getByRole('button', { name: '查看大图：外链 GIF' });
		await expect(control).toBeVisible({ timeout: 20_000 });
		await control.click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.locator('[data-photos-viewer-caption]')).toHaveText('外链 GIF');
		// Plain mode: no counter, no neighbour buttons.
		await expect(page.locator('[data-photos-viewer-counter]')).toHaveCount(0);
		await expect(page.getByRole('button', { name: '上一张' })).toHaveCount(0);
		const stageImage = page.locator('[data-photos-viewer-stage] img');
		await expect(stageImage).toHaveAttribute('src', new RegExp(`^${ORIGIN}/i/`));
	});

	test('in-link images keep their link and broken images stay plain', async ({ page }) => {
		requireBytes();
		await page.goto(`/zh-cn/${SLUG}`);
		// Wait for the enhancement to settle: two controls (the linked and the
		// broken one never become controls).
		await expect(page.getByRole('button', { name: '查看大图：正文 GIF' })).toBeVisible({
			timeout: 20_000
		});
		await expect.poll(() => page.locator('img[data-content-lightbox]').count()).toBe(2);

		const linked = page.locator('a[href="#clbox-anchor"] img');
		await expect(linked).not.toHaveAttribute('role', 'button');
		await linked.click();
		await expect(page).toHaveURL(/#clbox-anchor$/);
		await expect(page.getByRole('dialog')).toHaveCount(0);

		const broken = page.locator('img[alt="坏图"]');
		await expect(broken).not.toHaveAttribute('role', 'button');
	});

	test('axe reports no critical violations and SSR output stays plain', async ({ page }) => {
		requireBytes();
		await page.goto(`/zh-cn/${SLUG}`);
		await expect(page.getByRole('button', { name: '查看大图：正文 GIF' })).toBeVisible({
			timeout: 20_000
		});
		const results = await new AxeBuilder({ page }).analyze();
		const summary = results.violations.map(
			(violation) => `${violation.impact}: ${violation.id} (${violation.nodes.length})`
		);
		if (summary.length > 0) console.log('[axe:content-lightbox]', summary.join(' | '));
		expect(
			results.violations.filter((violation) => violation.impact === 'critical'),
			JSON.stringify(summary)
		).toEqual([]);

		// Progressive enhancement: the server output carries the plain image
		// and none of the control attributes (no-JS keeps working images).
		const response = await page.request.get(`/zh-cn/${SLUG}`);
		const html = await response.text();
		expect(html).toContain(`/i/${KEY_INTERNAL}`);
		expect(html).not.toContain('data-content-lightbox');
	});
});
