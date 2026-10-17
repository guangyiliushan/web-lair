import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * Comment P3b — B1 acceptance (segment anchors on the public read path).
 *
 * The anchors are inserted straight into the live database, so this spec
 * exercises the *resolution + marking* contract without depending on the
 * selection UI (that is B2's end-to-end case):
 *   1. a resolved anchor renders `span.wl-cm` with `id="c-<comment>"` on the
 *      server (works without JavaScript),
 *   2. the list shows the quote chip and a "jump to source" link,
 *   3. an anchor whose quote no longer exists lands in the folded
 *      "original text changed" area with its own count, never the main list,
 *   4. the moderation queue shows the quote plus its context window.
 *
 * Fixture namespace `e2e-cmtb`; the body is multi-block on purpose (heading,
 * paragraphs, inline strong/code, inline math void, duplicated paragraph).
 */
const CATEGORY = '00000000-0000-7000-8000-0000000000b1';
const POST = '00000000-0000-7000-8000-0000000000b2';
const C_MARK = '00000000-0000-7000-8000-0000000000c1';
const C_MARK2 = '00000000-0000-7000-8000-0000000000c2';
const C_ORPHAN = '00000000-0000-7000-8000-0000000000c3';
const C_PLAIN = '00000000-0000-7000-8000-0000000000c4';

const POST_PATH = '/zh-cn/posts/e2e-cmtb-post';
const T_MARK = 'e2e-cmtb 段评一';
const T_MARK2 = 'e2e-cmtb 段评二';
const T_ORPHAN = 'e2e-cmtb 失锚段评';
const T_PLAIN = 'e2e-cmtb 文章级评论';

/**
 * Stored anchor jsonb; hash/occ are fallback hints, L0 matches ord+range+quote.
 * prefix/suffix only feed the moderation queue's context window (the write path
 * derives them itself; these rows are inserted straight into the database).
 */
function anchor(
	ord: number,
	start: number,
	end: number,
	exact: string,
	context: { prefix?: string; suffix?: string } = {}
): string {
	return `{"v":1,"lang":"zh-cn","block":{"hash":"0000000000","occ":0,"ord":${ord}},"range":{"start":${start},"end":${end}},"quote":{"exact":"${exact}","prefix":"${context.prefix ?? ''}","suffix":"${context.suffix ?? ''}"}}`;
}

test.use(zhCnLocale);
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
	psql(`delete from comments where text like 'e2e-cmtb%'`);
	psql(`delete from comments where post_id = '${POST}'`);
	psql(`delete from posts where slug like 'e2e-cmtb-%'`);
	psql(`delete from categories where slug = 'e2e-cmtb-cat'`);
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', 'E2E 段评', 'e2e-cmtb-cat') on conflict (slug) do nothing`
	);
	psql(`insert into posts (id, title, slug, lang, content, category_id, status, published_at)
		values ('${POST}', 'E2E 段评文章', 'e2e-cmtb-post', 'zh-cn',
		'## 段落标题\n\n第一段，含 **加粗** 与 \`inline code\` 的行内格式。\n\n第二段带行内数学 $x^2$ 与后续文字。\n\n重复段落。\n\n重复段落。',
		'${CATEGORY}', 'published', now() - interval '1 hour') on conflict (id) do nothing`);
	psql(`insert into comments (id, post_id, author, text, state, anchor, created_at) values
		('${C_MARK}', '${POST}', 'e2e-cmtb', '${T_MARK}', 'approved', '${anchor(1, 0, 3, '第一段', { suffix: '，含' })}'::jsonb, now() - interval '4 minutes'),
		('${C_MARK2}', '${POST}', 'e2e-cmtb', '${T_MARK2}', 'approved', '${anchor(2, 10, 14, '后续文字')}'::jsonb, now() - interval '3 minutes'),
		('${C_ORPHAN}', '${POST}', 'e2e-cmtb', '${T_ORPHAN}', 'approved', '${anchor(1, 0, 6, '不存在的文字')}'::jsonb, now() - interval '2 minutes'),
		('${C_PLAIN}', '${POST}', 'e2e-cmtb', '${T_PLAIN}', 'approved', null, now() - interval '1 minute')`);
});

test.afterAll(() => {
	psql(`delete from comments where text like 'e2e-cmtb%'`);
	psql(`delete from comments where post_id = '${POST}'`);
	psql(`delete from posts where id = '${POST}'`);
	psql(`delete from categories where id = '${CATEGORY}'`);
});

test('resolved anchors render as server-side marks with deep-link ids', async ({ page }) => {
	await page.goto(POST_PATH);

	const mark = page.locator(`[id="c-${C_MARK}"]`);
	await expect(mark).toBeVisible();
	await expect(mark).toHaveClass(/wl-cm/);
	await expect(mark).toHaveText('第一段');
	// The mark must actually look like a mark (spec §7/§12.4): a class alone was
	// green while the stylesheet had no `.wl-cm` rule at all.
	await expect(mark).toHaveCSS('text-decoration-line', 'underline');
	await expect(mark).toHaveCSS('text-decoration-style', 'wavy');

	const mark2 = page.locator(`[id="c-${C_MARK2}"]`);
	await expect(mark2).toBeVisible();
	await expect(mark2).toHaveText('后续文字');

	// The quote chips live in the unified list, one per anchored root.
	const row = page.locator(`[data-comment-id="${C_MARK}"]`);
	await expect(row).toContainText(T_MARK);
	await expect(row).toContainText('第一段');
	await expect(row.getByRole('link', { name: '跳至原文' })).toHaveAttribute('href', `#c-${C_MARK}`);

	// An article-level comment still renders without a chip.
	const plain = page.locator(`[data-comment-id="${C_PLAIN}"]`);
	await expect(plain).toContainText(T_PLAIN);
	await expect(plain.locator('[data-slot="comment-anchor"]')).toHaveCount(0);

	// Main count excludes the orphan; the orphan has its own explicit count.
	await expect(page.locator('#comments-title')).toContainText('(3)');
	await expect(page.locator('[data-slot="comment-orphan-count"]')).toContainText(
		'条评论无法对应正文'
	);
});

test('a stale anchor is folded away from the main list and stays readable', async ({ page }) => {
	await page.goto(POST_PATH);

	const fold = page.locator('[data-slot="comment-orphans"]');
	await expect(fold).toBeVisible();
	// Closed by default: the fold is a courtesy, not a second main list.
	expect(await fold.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);

	await fold.locator('summary').click();
	await expect(fold).toContainText(T_ORPHAN);
	await expect(fold).toContainText('不存在的文字');
	// No jump link: there is no passage to jump to.
	await expect(fold.locator('a[href^="#c-"]')).toHaveCount(0);
});

test('marks survive without JavaScript (SSR only)', async ({ browser }) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: zhCnLocale.storageState
	});
	const page = await context.newPage();
	await page.goto(POST_PATH);

	const html = await page.content();
	expect(html).toContain(`id="c-${C_MARK}"`);
	expect(html).toContain('wl-cm');
	// The quote chip and the jump link are plain SSR markup too.
	expect(html).toContain('跳至原文');
	await context.close();
});

test('a deep link lands on the marked passage', async ({ page }) => {
	await page.goto(`${POST_PATH}#c-${C_MARK}`);
	await expect(page.locator(`[id="c-${C_MARK}"]`)).toBeVisible();
	expect(await page.evaluate(() => window.location.hash)).toBe(`#c-${C_MARK}`);
});

test('the moderation queue shows the quote and its context window', async ({ browser }) => {
	test.setTimeout(90_000);
	const context = await browser.newContext({ storageState: zhCnLocale.storageState });
	const page = await context.newPage();
	// Loopback owner auto-login: reaching the queue proves the session.
	await page.goto('/admin/comments?state=approved');
	const row = page.locator('label').filter({ hasText: T_MARK });
	await expect(row).toBeVisible({ timeout: 20000 });
	await expect(row.locator('[data-slot="comment-anchor-context"]')).toContainText('第一段');
	// Context window: prefix + exact + suffix from the stored anchor.
	await expect(row.locator('[data-slot="comment-anchor-context"]')).toContainText('含');
	await context.close();
});

test('the list jump link is keyboard activatable and targets the mark', async ({ page }) => {
	await page.goto(POST_PATH);
	const link = page.locator('a[href^="#c-"]').first();
	await link.focus();
	await expect(link).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/#c-/);
	const id = (await link.getAttribute('href'))!.slice(1);
	const mark = page.locator(`[id="${id}"]`);
	await expect(mark).toBeVisible();
	// `:target` paints the passage, so the deep link is visibly resolved even
	// without reading the address bar (WCAG 1.4.1 non-colour cue is the wavy
	// underline itself; this asserts the target state is real).
	const background = await mark.evaluate((node) => getComputedStyle(node).backgroundColor);
	expect(background).not.toBe('rgba(0, 0, 0, 0)');
});

test('the mark underline keeps a 3:1 contrast against the page background', async ({ page }) => {
	await page.goto(POST_PATH);
	const ratio = await page.evaluate(() => {
		const mark = document.querySelector('.wl-cm');
		if (!mark) return null;
		const canvas = document.createElement('canvas');
		const context = canvas.getContext('2d');
		if (!context) return null;
		const luminance = (color: string): number => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
			const channel = (value: number) => {
				const s = value / 255;
				return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			};
			return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
		};
		const transparent = (color: string) => color === 'rgba(0, 0, 0, 0)' || color === 'transparent';
		let background = 'rgb(255, 255, 255)';
		for (const node of [document.documentElement, document.body]) {
			const color = getComputedStyle(node).backgroundColor;
			if (!transparent(color)) {
				background = color;
				break;
			}
		}
		const foreground = getComputedStyle(mark).textDecorationColor;
		const a = luminance(foreground);
		const b = luminance(background);
		return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	});
	expect(ratio).not.toBeNull();
	// WCAG 2.2 SC 1.4.11 (non-text contrast) for the anchor underline.
	expect(ratio as number).toBeGreaterThanOrEqual(3);
});

