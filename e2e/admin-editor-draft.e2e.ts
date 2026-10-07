import { expect, test, type Locator, type Page } from '@playwright/test';
import { psql } from './support';

/**
 * P2 writing chain (ledger §9.2/§9.10) - owner flow against the real editor,
 * the real database and the real publish transaction:
 *
 *   autosave -> reload restore -> publish -> edit isolation v2 -> publish v2
 *   -> two-tab conflict (409) -> draft discard -> translation prefill
 *   -> placeholder discard (empty posts row goes with the draft)
 *
 * The localhost origin auto-authenticates as the site owner (see auth.e2e.ts /
 * TAILSCALE_ALLOW_LOOPBACK). Draft saves are throttled server-side to one
 * write per 30s per draft, so each step waits for the visible save indicator
 * instead of racing the debounce; the conflict step deliberately drives two
 * pages to force a version mismatch.
 */
const CATEGORY = '00000000-0000-7000-8000-000000000020';
const CATEGORY_NAME = 'E2E Editor';
const TITLE = 'e2e writing chain';
const SLUG = 'e2e-writing-chain';

function byText(page: Page, text: string | RegExp): Locator {
	return page.getByText(text).filter({ visible: true });
}

function cleanup() {
	psql(`delete from drafts where title ilike 'e2e writing%'`);
	psql(`delete from drafts where ref_id in (select id from posts where slug like 'e2e-writing%')`);
	psql(`delete from slug_trackers where slug like 'e2e-writing%'`);
	psql(`delete from posts where slug like 'e2e-writing%' or title ilike 'e2e writing%'`);
}

// Long serial chain: keep the per-test budget above the sum of the inner
// waits with headroom for a loaded machine (the old 180s was ~15s short of the
// worst case; review finding). NOTE: this spec owns fixed fixture ids on the
// shared dev database - never run it twice concurrently (each run would see
// the other's rows and both would fail).
test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(() => {
	cleanup();
	// Idempotent fixture (P2 review finding): a leftover row under either key
	// used to make the fixed-id insert fail with categories_pkey and turn the
	// whole serial file red before a single test ran.
	psql(`delete from categories where id = '${CATEGORY}' or slug = 'e2e-editor-cat'`);
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', '${CATEGORY_NAME}', 'e2e-editor-cat') on conflict (id) do update set name = excluded.name, slug = excluded.slug`
	);
});

test.afterAll(() => {
	cleanup();
	psql(`delete from categories where slug = 'e2e-editor-cat'`);
});

/** Pick the category inside the settings sheet (required before the first save). */
async function pickCategory(page: Page) {
	const sheetOpen = async () => await page.locator('#settings-category').isVisible();
	await expect(async () => {
		if (!(await sheetOpen())) {
			await page.getByRole('button', { name: '文章设置' }).click();
		}
		await expect(page.locator('#settings-category')).toBeVisible({ timeout: 10000 });
	}).toPass({ timeout: 20000 });
	// Retry the whole pick until the trigger shows the selection: under a
	// loaded machine the first clicks can be swallowed (exactly this step
	// timed out at 180s in a concurrent full-suite run - review finding).
	await expect(async () => {
		await page.locator('#settings-category').click();
		await page
			.locator('[data-slot="select-item"]')
			.filter({ hasText: CATEGORY_NAME })
			.click({ timeout: 3000 });
		await expect(page.locator('#settings-category')).toContainText(CATEGORY_NAME, {
			timeout: 2000
		});
	}).toPass({ timeout: 25000 });
	await page.keyboard.press('Escape');
}

async function typeIntoEditor(page: Page, text: string) {
	const editor = page.getByRole('textbox', { name: '输入正文...' });
	await expect(editor).toBeVisible({ timeout: 10000 });
	const probe = text.trim().split(/\s+/)[0];
	await expect(async () => {
		const current = await editor.innerText();
		if (!current.includes(probe)) {
			await editor.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.type(text);
		}
		await expect(editor).toContainText(probe, { timeout: 2000 });
	}).toPass({ timeout: 25000 });
}

async function fillTitle(page: Page, value: string) {
	const titleInput = page.locator('input[name="title"]');
	// Hydration gate: type a probe until a state-derived signal (the slug
	// chip) actually reacts - pre-hydration keystrokes only touch the DOM and
	// are invisible to the app (the full-suite load makes that window long).
	await expect(async () => {
		await titleInput.click();
		await page.keyboard.press('Control+A');
		await page.keyboard.type('probe');
		await expect(byText(page, '/probe')).toBeVisible({ timeout: 1500 });
	}).toPass({ timeout: 30000 });
	await titleInput.click();
	await page.keyboard.press('Control+A');
	await page.keyboard.type(value);
	await expect(titleInput).toHaveValue(value, { timeout: 5000 });
}

async function waitSaved(page: Page) {
	// Autosave can be throttled server-side (30s window) and retried, so give
	// the indicator room to turn green.
	await expect(byText(page, /已保存/)).toBeVisible({ timeout: 60000 });
}

test('autosaves a new article and restores it after a reload', async ({ page }) => {
	await page.goto('/admin/posts/edit');
	await fillTitle(page, TITLE);
	// Auto slug derives from the latin title.
	await expect(byText(page, `/${SLUG}`)).toBeVisible({ timeout: 10000 });

	await typeIntoEditor(page, 'Hello e2e body');
	// Before a category is chosen the server save gate is visible...
	await expect(byText(page, '选定分类后开始自动保存')).toBeVisible({ timeout: 10000 });
	await pickCategory(page);
	// ...and afterwards the autosave lands within the debounce window.
	await waitSaved(page);

	// The placeholder posts row is keyed by a temp slug until publish, so the
	// working copy (real slug) is the anchor for these checks.
	expect(psql(`select count(*) from drafts where slug = '${SLUG}'`)).toBe('1');
	expect(
		psql(
			`select p.lang || '/' || p.status from posts p join drafts d on d.ref_id = p.id where d.slug = '${SLUG}'`
		)
	).toBe('en/draft');

	// The URL was anchored to the row; a reload must show the working copy.
	await expect.poll(() => page.url()).toContain('id=');
	await page.reload();
	await expect(page.locator('input[name="title"]')).toHaveValue(TITLE, { timeout: 10000 });
	await expect(page.getByRole('textbox', { name: '输入正文...' })).toContainText('Hello e2e body');
});

test('publishes the draft: posts gets content, revision and the draft is gone', async ({
	page
}) => {
	// A publish moves the draft slug onto the post; before that the post row
	// still carries the temp slug, so locate it through the draft.
	const id = psql(`select ref_id from drafts where slug = '${SLUG}'`);
	await page.goto(`/admin/posts/edit?id=${id}`);
	await expect(page.locator('input[name="title"]')).toHaveValue(TITLE, { timeout: 10000 });

	await expect(async () => {
		await page.getByRole('button', { name: '发布' }).click();
		await page.waitForURL(/published=1/, { timeout: 15000 });
	}).toPass({ timeout: 30000 });

	expect(psql(`select status || '/' || version from posts where id = '${id}'`)).toBe('published/1');
	expect(psql(`select count(*) from drafts where ref_id = '${id}'`)).toBe('0');
	expect(psql(`select count(*) from post_revisions where post_id = '${id}'`)).toBe('1');
	expect(psql(`select published_at is not null from posts where id = '${id}'`)).toBe('t');
});

test('edits a published article in isolation, then publishes v2 with a slug tracker', async ({
	page
}) => {
	const id = psql(`select id from posts where slug = '${SLUG}'`);
	await page.goto(`/admin/posts/edit?id=${id}`);

	await typeIntoEditor(page, ' v2 change');
	// Change the slug through the dialog so the tracker path is exercised.
	const slugInput = page.locator('input[name="slug-input"]');
	await expect(async () => {
		if (!(await slugInput.isVisible())) {
			await page.getByRole('button', { name: '添加 slug' }).click();
		}
		await expect(slugInput).toBeVisible({ timeout: 5000 });
	}).toPass({ timeout: 20000 });
	await slugInput.fill(`${SLUG}-v2`);
	await page.getByRole('button', { name: '确定' }).click();

	await waitSaved(page);

	// Isolation: posts still carries v1 while the working copy holds the edits.
	expect(psql(`select version from posts where id = '${id}'`)).toBe('1');
	expect(psql(`select slug from posts where id = '${id}'`)).toBe(SLUG);
	expect(psql(`select count(*) from drafts where ref_id = '${id}'`)).toBe('1');
	expect(psql(`select content from drafts where ref_id = '${id}'`)).toContain('v2 change');

	await expect(async () => {
		await page.getByRole('button', { name: '发布' }).click();
		await page.waitForURL(/published=1/, { timeout: 15000 });
	}).toPass({ timeout: 30000 });

	expect(psql(`select version from posts where id = '${id}'`)).toBe('2');
	expect(psql(`select slug from posts where id = '${id}'`)).toBe(`${SLUG}-v2`);
	expect(psql(`select count(*) from post_revisions where post_id = '${id}'`)).toBe('2');
	expect(
		psql(`select count(*) from slug_trackers where slug = '${SLUG}' and target_id = '${id}'`)
	).toBe('1');
	expect(psql(`select count(*) from drafts where ref_id = '${id}'`)).toBe('0');
});

test('a stale tab hits the 409 conflict banner and can reload the server state', async ({
	browser
}) => {
	const id = psql(`select id from posts where slug = '${SLUG}-v2'`);
	const pageA = await browser.newPage();
	const pageB = await browser.newPage();
	await pageA.goto(`/admin/posts/edit?id=${id}`);
	await pageB.goto(`/admin/posts/edit?id=${id}`);

	// A saves first (creates the draft), so B starts from a stale base.
	await typeIntoEditor(pageA, ' from A');
	await waitSaved(pageA);
	await typeIntoEditor(pageB, ' from B');
	await waitSaved(pageB);
	// A still holds version 1; the manual save bypasses the autosave throttle
	// so the stale version is rejected right away.
	await typeIntoEditor(pageA, ' again');
	await pageA.getByRole('button', { name: '保存草稿' }).click();
	await expect(byText(pageA, /已在其他窗口更新/)).toBeVisible({ timeout: 30000 });
	await expect(pageA.getByRole('button', { name: '载入服务端最新' })).toBeVisible();

	expect(psql(`select count(*) from drafts where ref_id = '${id}'`)).toBe('1');
	await pageA.getByRole('button', { name: '载入服务端最新' }).click();
	await expect(pageA.getByRole('button', { name: '载入服务端最新' })).toBeHidden({
		timeout: 15000
	});
	await pageA.close();
	await pageB.close();
});

test('admin lists reflect pending changes', async ({ page }) => {
	// Gate P2 names the admin list regression; the badge column is the only
	// consumer of draftsForPosts - pin it here (review finding).
	await page.goto('/admin/posts');
	const row = page.getByRole('row').filter({ hasText: TITLE });
	await expect(row.first()).toBeVisible({ timeout: 10000 });
	await expect(row.first().getByText('有未发布改动')).toBeVisible();

	await page.goto('/admin/posts?status=published');
	await expect(page.getByRole('row').filter({ hasText: TITLE }).first()).toBeVisible({
		timeout: 10000
	});

	await page.goto('/admin/drafts');
	await expect(page.getByRole('row').filter({ hasText: TITLE }).first()).toBeVisible({
		timeout: 10000
	});
});

test('discards the working copy from the drafts page', async ({ page }) => {
	await page.goto('/admin/drafts');
	const row = page.getByRole('row').filter({ hasText: 'e2e writing chain' });
	await expect(row.first()).toBeVisible({ timeout: 10000 });
	const id = psql(`select id from posts where slug = '${SLUG}-v2'`);

	await expect(async () => {
		await row.first().getByRole('button', { name: '丢弃草稿' }).click();
		await expect(page.getByRole('alertdialog')).toBeVisible();
	}).toPass({ timeout: 20000 });
	await page.getByRole('button', { name: '丢弃', exact: true }).click();

	await expect(byText(page, '草稿已丢弃。')).toBeVisible({ timeout: 15000 });
	expect(psql(`select count(*) from drafts where ref_id = '${id}'`)).toBe('0');
	// The published article itself is untouched by a discard.
	expect(psql(`select version from posts where id = '${id}'`)).toBe('2');
});

test('creates a translation draft with the copy prefill (§9.20.4)', async ({ page }) => {
	const id = psql(`select id from posts where slug = '${SLUG}-v2'`);
	const group = psql(`select translation_group from posts where id = '${id}'`);
	await page.goto(`/admin/posts/edit?id=${id}`);

	await expect(async () => {
		await page.getByRole('button', { name: '文章设置' }).click();
		await expect(page.getByRole('button', { name: '创建翻译' })).toBeVisible({ timeout: 10000 });
	}).toPass({ timeout: 20000 });
	await page.getByRole('button', { name: '创建翻译' }).click();

	const dialog = page.getByRole('dialog', { name: '创建翻译' });
	await expect(dialog).toBeVisible();
	await dialog.locator('[data-slot="select-trigger"]').click();
	await page.locator('[data-slot="select-item"]').filter({ hasText: 'zh-cn' }).click();
	await dialog.getByRole('button', { name: '创建' }).click();

	await page.waitForURL(/translation=1/, { timeout: 15000 });
	await expect(byText(page, '翻译草稿已创建')).toBeVisible();

	const translatedId = psql(
		`select id from posts where translated_from_post_id = '${id}' and lang = 'zh-cn'`
	);
	expect(translatedId).not.toBe('');
	expect(
		psql(`select translation_group = '${group}' from posts where id = '${translatedId}'`)
	).toBe('t');
	expect(psql(`select status from posts where id = '${translatedId}'`)).toBe('draft');
	expect(
		psql(
			`select (slug is null)::text || '/' || (content like '%v2 change%')::text from drafts where ref_id = '${translatedId}'`
		)
	).toBe('true/true');

	// The editor shows the pending-translation marker and the prefilled body.
	await expect(byText(page, /译文（待翻译）/)).toBeVisible();
	await expect(page.getByRole('textbox', { name: '输入正文...' })).toContainText('v2 change');
});

test('discards a never-published placeholder together with its empty posts row', async ({
	page
}) => {
	await page.goto('/admin/posts/edit');
	await fillTitle(page, 'e2e writing orphan');
	await typeIntoEditor(page, 'orphan body');
	await pickCategory(page);
	await waitSaved(page);

	const id = psql(`select ref_id from drafts where slug = 'e2e-writing-orphan'`);
	expect(id).not.toBe('');

	await expect(async () => {
		await page.getByRole('button', { name: '文章设置' }).click();
		await expect(page.getByRole('button', { name: '丢弃草稿' })).toBeVisible({ timeout: 10000 });
	}).toPass({ timeout: 20000 });
	await page.getByRole('button', { name: '丢弃草稿' }).click();
	await expect(page.getByRole('alertdialog')).toBeVisible();
	await page.getByRole('button', { name: '丢弃', exact: true }).click();

	await page.waitForURL(/\/admin\/posts(\?discarded=1)?$/, { timeout: 15000 });
	expect(psql(`select count(*) from posts where id = '${id}'`)).toBe('0');
	expect(psql(`select count(*) from drafts where ref_id = '${id}'`)).toBe('0');
});
