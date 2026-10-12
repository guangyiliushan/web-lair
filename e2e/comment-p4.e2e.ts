import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { apiPost, psql, valkeyDel } from './support';

/**
 * Comment P4 acceptance (pages plan T8): the reader self-service - edit ->
 * pending + edited_at + the public edited marker; soft delete -> floor
 * placeholder with the reply kept and pin dropped; author-only entries (a
 * guest and another verified reader get none); an edited root hides its
 * whole subtree until the re-approval; the pages mount (a comment on a
 * universal md page + the queue's page target).
 *
 * Serial chain against the production preview and the live database;
 * fixtures are namespaced `e2e-p4` and removed in teardown. Reader writes
 * share the 60s<=2 comment window, which the chain clears between steps (the
 * window itself is P3a's case) so it cannot eat itself.
 */
const CATEGORY = '00000000-0000-7000-8000-0000000000f1';
const POST = '00000000-0000-7000-8000-0000000000f2';
const PAGE = '00000000-0000-7000-8000-0000000000f3';

const POST_PATH = '/zh-cn/posts/e2e-p4-post';
const PAGE_PATH = '/zh-cn/e2e-p4-page';

const READER_EMAIL = 'e2e-p4-reader@example.com';
const OTHER_EMAIL = 'e2e-p4-other@example.com';
const READER_PASSWORD = 'e2e-p4-password-1';

const T_R1 = 'e2e-p4 初稿';
const T_R2 = 'e2e-p4 修订稿';
const T_R3 = 'e2e-p4 二稿';
const T_REPLY = 'e2e-p4 的回复';
const T_PAGE = 'e2e-p4 页面评论';
const PAGE_TITLE = 'E2E 评论页面';

/** Root-composer submit, scoped to the ?/comment form (composer conventions). */
function rootSubmit(page: Page) {
	return page.locator('form[action="?/comment"]').getByRole('button', { name: '发表' });
}

let readerUid = '';
let commentId = '';

/** Reader writes share the 60s<=2 window; keep the chain deterministic. */
function clearWindow() {
	if (readerUid) valkeyDel(`wl:limits:comment:${readerUid}`);
}

test.use(zhCnLocale);
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(() => {
	psql(`delete from comments where text like 'e2e-p4%'`);
	psql(`delete from comments where post_id = '${POST}' or page_id = '${PAGE}'`);
	psql(`delete from posts where slug like 'e2e-p4-%'`);
	psql(`delete from pages where slug like 'e2e-p4-%'`);
	psql(`delete from categories where slug = 'e2e-p4-cat'`);
	psql(`delete from "user" where email in ('${READER_EMAIL}', '${OTHER_EMAIL}')`);
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', 'E2E P4', 'e2e-p4-cat') on conflict (slug) do nothing`
	);
	psql(
		`insert into posts (id, title, slug, lang, content, category_id, status, published_at)
		 values ('${POST}', 'E2E P4 文章', 'e2e-p4-post', 'zh-cn', '正文内容', '${CATEGORY}', 'published', now() - interval '1 hour')
		 on conflict (id) do nothing`
	);
	psql(
		`insert into pages (id, slug, title, content, content_format, status)
		 values ('${PAGE}', 'e2e-p4-page', '{"zh-cn":"${PAGE_TITLE}"}'::jsonb, '{"zh-cn":"## 页面正文"}'::jsonb, 'markdown', 'visible')
		 on conflict (id) do nothing`
	);
});

test.afterAll(async () => {
	const otherUid = psql(`select id from "user" where email = '${OTHER_EMAIL}'`);
	for (const uid of [readerUid, otherUid]) {
		if (uid) valkeyDel(`wl:limits:comment:${uid}`);
	}
	psql(`delete from comments where text like 'e2e-p4%'`);
	psql(`delete from comments where post_id = '${POST}' or page_id = '${PAGE}'`);
	psql(`delete from posts where slug like 'e2e-p4-%'`);
	psql(`delete from pages where slug like 'e2e-p4-%'`);
	psql(`delete from categories where slug = 'e2e-p4-cat'`);
	psql(`delete from "user" where email in ('${READER_EMAIL}', '${OTHER_EMAIL}')`);
	await readerContext?.close();
	await otherContext?.close();
});

/* ── auth fixtures ──────────────────────────────────────────────────────── */

/** Sign-up + SQL-verify + explicit sign-in (spec §1 "已验证读者"). */
async function bootstrapReader(context: BrowserContext, email: string) {
	const page = await context.newPage();
	const signUp = await apiPost(page, '/api/auth/sign-up/email', {
		email,
		name: email,
		password: READER_PASSWORD
	});
	expect(signUp.ok()).toBeTruthy();
	psql(`update "user" set email_verified = true where email = '${email}'`);
	const signIn = await apiPost(page, '/api/auth/sign-in/email', {
		email,
		password: READER_PASSWORD
	});
	expect(signIn.ok()).toBeTruthy();
	await page.close();
}

/** Memoised signed-in contexts: one auth round per account per file. */
let readerContext: BrowserContext | null = null;
let otherContext: BrowserContext | null = null;

async function readerPage(browser: Browser): Promise<Page> {
	if (!readerContext) {
		readerContext = await browser.newContext({ storageState: zhCnLocale.storageState });
		await bootstrapReader(readerContext, READER_EMAIL);
		readerUid = psql(`select id from "user" where email = '${READER_EMAIL}'`);
	}
	return readerContext.newPage();
}

async function otherPage(browser: Browser): Promise<Page> {
	if (!otherContext) {
		otherContext = await browser.newContext({ storageState: zhCnLocale.storageState });
		await bootstrapReader(otherContext, OTHER_EMAIL);
	}
	return otherContext.newPage();
}

async function guestContext(browser: Browser) {
	return browser.newContext({ storageState: zhCnLocale.storageState });
}

/**
 * Open a comment's inline surface. The buttons render in the SSR HTML, so a
 * pre-hydration click is swallowed under load - retry until the surface
 * actually shows (house pattern).
 */
async function openSurface(
	page: Page,
	itemSelector: string,
	name: string | RegExp,
	surface: string
) {
	const item = page.locator(itemSelector);
	await expect(async () => {
		await item.getByRole('button', { name }).first().click();
		await expect(page.locator(surface)).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20000 });
}

/**
 * Edit a comment through the UI with a convergence loop: retry the whole
 * open -> fill -> save cycle until the rendered body carries the new text
 * (a swallowed click or a mid-flight save must not wedge the chain).
 */
async function editComment(page: Page, itemSelector: string, text: string) {
	const item = page.locator(itemSelector);
	const form = page.locator('form[action="?/edit"]');
	await expect(async () => {
		if ((await form.count()) === 0) {
			// .first(): a root item nests its replies' buttons too; the root's
			// own action row precedes the replies list in document order.
			await item.getByRole('button', { name: '编辑' }).first().click();
			await expect(form).toBeVisible({ timeout: 2000 });
		}
		clearWindow();
		await form.locator('textarea').fill(text);
		await form.getByRole('button', { name: '保存' }).click();
		await expect(page.locator(itemSelector)).toContainText(text, { timeout: 5000 });
	}).toPass({ timeout: 60000 });
}

/** Owner approves one queue row (target display asserted by the caller). */
async function ownerApprove(browser: Browser, text: string, badge: string) {
	const owner = await guestContext(browser);
	const ownerPage = await owner.newPage();
	await ownerPage.goto('/admin/comments');
	const row = ownerPage.locator('label').filter({ hasText: text });
	await expect(row).toBeVisible({ timeout: 15000 });
	await expect(row.getByText(badge, { exact: true })).toBeVisible();
	const id = psql(`select id from comments where text = '${text}'`);
	await ownerPage.locator(`input[name="ids"][value="${id}"]`).check();
	await ownerPage.getByRole('button', { name: '通过' }).click();
	await expect(ownerPage.getByText('已通过 1 条')).toBeVisible();
	expect(psql(`select state from comments where id = '${id}'`)).toBe('approved');
	await owner.close();
}

/* ── T8 acceptance ──────────────────────────────────────────────────────── */

test('reader submits and edits: pending + edited_at, own row shows the marker', async ({
	browser
}) => {
	const page = await readerPage(browser);
	await page.goto(POST_PATH);
	await page.getByRole('textbox', { name: '评论内容' }).fill(T_R1);
	await rootSubmit(page).click();
	await expect(page.getByText(T_R1)).toBeVisible();
	commentId = psql(`select id from comments where text = '${T_R1}'`);
	clearWindow();

	const item = `[data-comment-id="${commentId}"]`;
	await openSurface(page, item, '编辑', 'form[action="?/edit"]');
	await editComment(page, item, T_R2);
	expect(
		psql(
			`select state || '|' || (edited_at is not null)::text from comments where id = '${commentId}'`
		)
	).toBe('pending|true');
	await expect(page.locator(item).getByText(T_R2)).toBeVisible();
	await expect(page.locator(item).getByText('已编辑')).toBeVisible();
	await page.close();
});

test('owner approves the edit; guests and other readers see no write entries', async ({
	browser
}) => {
	await ownerApprove(browser, T_R2, '文章');

	const guest = await guestContext(browser);
	const guestPage = await guest.newPage();
	await guestPage.goto(POST_PATH);
	const guestItem = guestPage.locator(`[data-comment-id="${commentId}"]`);
	await expect(guestItem.getByText(T_R2)).toBeVisible();
	await expect(guestItem.getByText('已编辑')).toBeVisible();
	expect(await guestPage.locator('[data-edit-target]').count()).toBe(0);
	expect(await guestPage.locator('[data-delete-target]').count()).toBe(0);
	await guest.close();

	const other = await otherPage(browser);
	await other.goto(POST_PATH);
	await expect(other.locator(`[data-comment-id="${commentId}"]`).getByText(T_R2)).toBeVisible();
	expect(await other.locator('[data-edit-target]').count()).toBe(0);
	expect(await other.locator('[data-delete-target]').count()).toBe(0);
	await other.close();
});

test('reader replies; the owner approves the reply', async ({ browser }) => {
	const page = await readerPage(browser);
	await page.goto(POST_PATH);
	const item = `[data-comment-id="${commentId}"]`;
	const replyForm = 'form[action="?/reply"]';
	await openSurface(page, item, /回复/, replyForm);
	await expect(async () => {
		await page.locator(replyForm).locator('textarea').fill(T_REPLY);
		await page.locator(replyForm).getByRole('button', { name: '发表' }).click();
		await expect(page.locator(item)).toContainText(T_REPLY, { timeout: 5000 });
	}).toPass({ timeout: 60000 });
	clearWindow();
	await page.close();

	await ownerApprove(browser, T_REPLY, '文章');
});

test('an edited root hides its subtree until the re-approval', async ({ browser }) => {
	const page = await readerPage(browser);
	await page.goto(POST_PATH);
	await editComment(page, `[data-comment-id="${commentId}"]`, T_R3);
	clearWindow();
	// The author still sees the own pending root and the reply.
	await expect(page.locator(`[data-comment-id="${commentId}"]`)).toContainText(T_REPLY);
	await page.close();

	const guest = await guestContext(browser);
	const guestPage = await guest.newPage();
	await guestPage.goto(POST_PATH);
	await expect(guestPage.getByText(T_R3)).toHaveCount(0);
	await expect(guestPage.getByText(T_REPLY)).toHaveCount(0);
	await guest.close();

	await ownerApprove(browser, T_R3, '文章');

	const restored = await guestContext(browser);
	const restoredPage = await restored.newPage();
	await restoredPage.goto(POST_PATH);
	await expect(
		restoredPage.locator(`[data-comment-id="${commentId}"]`).getByText(T_R3)
	).toBeVisible();
	await expect(restoredPage.getByText(T_REPLY)).toBeVisible();
	await restored.close();
});

test('reader soft-deletes the root: the placeholder keeps the reply, pin drops', async ({
	browser
}) => {
	psql(`update comments set pin = true where id = '${commentId}'`);
	const page = await readerPage(browser);
	await page.goto(POST_PATH);
	const item = `[data-comment-id="${commentId}"]`;
	await openSurface(page, item, '删除', '[data-slot="comment-delete-confirm"]');
	await expect(async () => {
		await page
			.locator('[data-slot="comment-delete-confirm"]')
			.getByRole('button', { name: '删除' })
			.click();
		expect(psql(`select is_deleted::text from comments where id = '${commentId}'`)).toBe('true');
	}).toPass({ timeout: 60000 });
	expect(
		psql(
			`select is_deleted || '|' || (deleted_at is not null)::text || '|' || pin::text from comments where id = '${commentId}'`
		)
	).toBe('true|true|false');
	await page.close();

	const guest = await guestContext(browser);
	const guestPage = await guest.newPage();
	await guestPage.goto(POST_PATH);
	await expect(guestPage.getByText('该评论已删除。').first()).toBeVisible();
	await expect(guestPage.getByText(T_REPLY)).toBeVisible();
	await expect(guestPage.getByText(T_R3)).toHaveCount(0);
	await guest.close();
});

test('the pages mount: a universal md page is commentable and the queue shows the target', async ({
	browser
}) => {
	const page = await readerPage(browser);
	await page.goto(PAGE_PATH);
	await page.getByRole('textbox', { name: '评论内容' }).fill(T_PAGE);
	await rootSubmit(page).click();
	await expect(page.locator('[data-comment-id]').filter({ hasText: T_PAGE })).toBeVisible();
	clearWindow();
	expect(
		psql(
			`select state || '|' || (page_id = '${PAGE}')::text from comments where text = '${T_PAGE}'`
		)
	).toBe('pending|true');
	await page.close();

	const guest = await guestContext(browser);
	const guestPage = await guest.newPage();
	await guestPage.goto(PAGE_PATH);
	await expect(guestPage.getByText(T_PAGE)).toHaveCount(0);
	await guest.close();

	const owner = await guestContext(browser);
	const ownerPage = await owner.newPage();
	await ownerPage.goto('/admin/comments');
	const row = ownerPage.locator('label').filter({ hasText: T_PAGE });
	await expect(row).toBeVisible({ timeout: 15000 });
	await expect(row.getByText('页面', { exact: true })).toBeVisible();
	await expect(row.getByText(PAGE_TITLE)).toBeVisible();
	await owner.close();
});
