import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { bootstrapReader, psql, valkeyDel } from './support';

/**
 * Comment P3b — B2 acceptance (selection -> anchor -> mark, end to end).
 *
 * B1 inserted stored anchors straight into the database; this spec drives the
 * real interaction instead: select text in the article, use the floating
 * action, submit through the form action, and check what the reader sees.
 * It covers the four states that only a browser can produce:
 *   1. guest: the action appears, the panel offers the login path,
 *   2. reader: a selection submits and waits for review (pending),
 *   3. owner: a selection is auto-approved and renders as a server-side mark,
 *   4. cross-block selections are rejected (registered v1 limit), and
 *      clicking a mark opens the in-place thread.
 *
 * Fixture namespace `e2e-cmts`; requires `web-lair-db-1` and port 4173 free.
 */
const CATEGORY = '00000000-0000-7000-8000-0000000000e1';
const POST = '00000000-0000-7000-8000-0000000000e2';
const POST_PATH = '/zh-cn/posts/e2e-cmts-post';
const READER_EMAIL = 'e2e-cmts-reader@example.com';
const READER_PASSWORD = 'e2e-cmts-password-1';

const SELECTION = '选择这段文字';
const OWNER_TEXT = 'e2e-cmts 老板的段评';
const READER_TEXT = 'e2e-cmts 读者的段评';

test.use(zhCnLocale);
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(() => {
	psql(`delete from comments where text like 'e2e-cmts%'`);
	psql(`delete from comments where post_id = '${POST}'`);
	psql(`delete from posts where slug = 'e2e-cmts-post'`);
	psql(`delete from categories where slug = 'e2e-cmts-cat' or id = '${CATEGORY}'`);
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', 'E2E 选区段评', 'e2e-cmts-cat') on conflict (slug) do nothing`
	);
	psql(`insert into posts (id, title, slug, lang, content, category_id, status, published_at)
		values ('${POST}', 'E2E 选区段评文章', 'e2e-cmts-post', 'zh-cn',
		'## 段评标题\n\n第一段：选择这段文字来评论。\n\n第二段：这里也有文字。',
		'${CATEGORY}', 'published', now() - interval '1 hour') on conflict (id) do nothing`);
});

test.afterAll(async () => {
	const uid = psql(`select id from "user" where email = '${READER_EMAIL}'`);
	if (uid) {
		valkeyDel(`wl:limits:comment:${uid}`);
		valkeyDel(`wl:limits:comment-anchor:${uid}`);
	}
	psql(`delete from comments where text like 'e2e-cmts%'`);
	psql(`delete from comments where post_id = '${POST}'`);
	psql(`delete from posts where id = '${POST}'`);
	psql(`delete from categories where id = '${CATEGORY}'`);
	psql(`delete from "user" where email = '${READER_EMAIL}'`);
	await readerContext?.close();
});

/* ── helpers ────────────────────────────────────────────────────────────── */

let readerContext: BrowserContext | null = null;

async function readerPage(browser: Browser): Promise<Page> {
	if (!readerContext) {
		readerContext = await browser.newContext({ storageState: zhCnLocale.storageState });
		await bootstrapReader(readerContext, READER_EMAIL, READER_PASSWORD);
	}
	return readerContext.newPage();
}

async function ownerPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ storageState: zhCnLocale.storageState });
	const page = await context.newPage();
	// Visiting the queue acquires the loopback owner session for this context.
	await page.goto('/admin/comments');
	await expect(page.getByRole('tab', { name: /待审/ })).toBeVisible({ timeout: 15000 });
	return { context, page };
}

/**
 * Select `needle` inside the paragraph that contains `paragraphContains`, then
 * nudge the layer the way a pointer release would (selectionchange + pointerup).
 */
async function selectInParagraph(page: Page, paragraphContains: string, needle: string) {
	// The marker exists only after the client effect ran (SSR renders null
	// container), so data-ready is the hydration signal for every case here.
	await page.waitForFunction(
		() =>
			document.querySelector('[data-slot="segment-layer"]')?.getAttribute('data-ready') === 'true',
		undefined,
		{ timeout: 30_000 }
	);
	await page.evaluate(
		({ paragraphContains, needle }) => {
			const el = [...document.querySelectorAll('p')].find((candidate) =>
				(candidate.textContent ?? '').includes(paragraphContains)
			);
			if (!el) throw new Error(`paragraph not found: ${paragraphContains}`);
			const node = el.firstChild;
			if (!node || node.nodeType !== Node.TEXT_NODE)
				throw new Error('paragraph is not a single text node');
			const text = node as Text;
			const start = text.data.indexOf(needle);
			if (start < 0) throw new Error(`needle not found: ${needle}`);
			const range = document.createRange();
			range.setStart(text, start);
			range.setEnd(text, start + needle.length);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			document.dispatchEvent(new Event('selectionchange'));
			el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		},
		{ paragraphContains, needle }
	);
	const action = page.getByRole('button', { name: '评论选中文字' });
	await expect(action).toBeVisible({ timeout: 8000 });
	return action;
}

async function submitSelection(page: Page, text: string) {
	const action = await selectInParagraph(page, '第一段', SELECTION);
	await action.click();
	const panel = page.getByRole('dialog', { name: '评论选中文字' });
	await expect(panel).toBeVisible();
	await expect(panel.getByText(`选中：${SELECTION}`)).toBeVisible();
	await panel.getByRole('textbox').fill(text);
	await panel.getByRole('button', { name: '发表' }).click();
}

/* ── cases ──────────────────────────────────────────────────────────────── */

test('guest: the action appears on a selection and the panel offers login', async ({ page }) => {
	await page.goto(POST_PATH);
	const action = await selectInParagraph(page, '第一段', SELECTION);
	await action.click();
	const panel = page.getByRole('dialog', { name: '评论选中文字' });
	await expect(panel).toBeVisible();
	await expect(panel.getByText('登录后参与讨论。')).toBeVisible();
	await expect(panel.getByRole('link', { name: '登录' })).toBeVisible();
	await panel.getByRole('button', { name: '关闭' }).click();
	await expect(panel).toBeHidden();
});

test('guest: a cross-block selection never offers the action', async ({ page }) => {
	await page.goto(POST_PATH);
	await page.evaluate(() => {
		const paragraphs = [...document.querySelectorAll('p')];
		const first = paragraphs.find((candidate) => (candidate.textContent ?? '').includes('第一段'));
		const second = paragraphs.find((candidate) => (candidate.textContent ?? '').includes('第二段'));
		if (!first?.firstChild || !second?.firstChild) throw new Error('paragraphs missing');
		const range = document.createRange();
		range.setStart(first.firstChild, 4);
		range.setEnd(second.firstChild, 2);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	});
	await page.waitForTimeout(400);
	await expect(page.getByRole('button', { name: '评论选中文字' })).toHaveCount(0);
});

test('reader: a selection submits and waits for review', async ({ browser }) => {
	const page = await readerPage(browser);
	await page.goto(POST_PATH);
	await submitSelection(page, READER_TEXT);
	await expect(page.getByText('已提交，待审核。')).toBeVisible({ timeout: 15000 });
	// The author sees their own pending comment as a dashed mark; the public
	// (approved-only) mark set stays untouched.
	await expect(page.locator('.wl-cm-pending', { hasText: SELECTION })).toHaveCount(1, {
		timeout: 15000
	});
	await expect(page.locator('.wl-cm:not(.wl-cm-pending)')).toHaveCount(0);
	const state = psql(
		`select state || ':' || (anchor is not null) from comments where text = '${READER_TEXT}'`
	);
	expect(state).toBe('pending:true');
	await page.close();
});

test('owner: a selection is auto-approved and renders a mark', async ({ browser }) => {
	const { context, page } = await ownerPage(browser);
	await page.goto(POST_PATH);
	await submitSelection(page, OWNER_TEXT);
	// Owner comments skip the queue, so the marks re-render on the same load.
	const mark = page.locator('.wl-cm', { hasText: SELECTION });
	await expect(mark).toHaveCount(1, { timeout: 15000 });
	await expect(mark).toHaveCSS('text-decoration-line', 'underline');
	const quote = psql(`select anchor->'quote'->>'exact' from comments where text = '${OWNER_TEXT}'`);
	expect(quote).toBe(SELECTION);
	await context.close();
});

test('clicking a mark opens the in-place thread', async ({ page }) => {
	await page.goto(POST_PATH);
	const mark = page.locator('.wl-cm', { hasText: SELECTION });
	await expect(mark).toHaveCount(1);
	// Same readiness contract as selectInParagraph: click only after the
	// layer's listeners exist.
	await page.waitForFunction(
		() =>
			document.querySelector('[data-slot="segment-layer"]')?.getAttribute('data-ready') === 'true',
		undefined,
		{ timeout: 30_000 }
	);
	await mark.click();
	const popover = page.getByRole('dialog', { name: '评论线程' });
	await expect(popover).toBeVisible();
	await expect(popover.getByText(OWNER_TEXT)).toBeVisible();
	await popover.getByRole('button', { name: '关闭' }).click();
	await expect(popover).toBeHidden();
});
