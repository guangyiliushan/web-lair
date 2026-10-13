import { expect, test, type Locator, type Page } from '@playwright/test';
import { bootstrapReader, ORIGIN, psql } from './support';
import { zhCnLocale } from './locale-fixture';

/**
 * 3a batch tail (Q1/Q10/Q11/Q12): the editor image chain end to end against
 * the real build, the real upload pipeline (sniff -> sharp -> RustFS) and the
 * real database - picker inserts, paste/drop uploads, and the tooth that
 * matters: the URLs the editor writes are fetchable by an ANONYMOUS reader
 * (the P0 this batch fixed was exactly "the inserted link 404s for every
 * reader on a source under the preview box").
 */
test.use(zhCnLocale);

const CATEGORY = '00000000-0000-7000-8000-000000000021';
const CATEGORY_NAME = 'E2E Editor Uploads';
const TITLE = 'e2e editor uploads';
const SLUG = 'e2e-editor-uploads';
const READER_EMAIL = 'e2e-uploads-reader@example.com';
const READER_PASSWORD = 'e2e-uploads-pass-1';

// Valid 1x1 PNG / GIF (the endpoint sniffs magic bytes; sharp decodes both).
const PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function byText(page: Page, text: string | RegExp): Locator {
	return page.getByText(text).filter({ visible: true });
}

function cleanup() {
	psql(`delete from drafts where title ilike 'e2e editor uploads%'`);
	psql(
		`delete from drafts where ref_id in (select id from posts where slug like 'e2e-editor-uploads%')`
	);
	psql(`delete from slug_trackers where slug like 'e2e-editor-uploads%'`);
	psql(
		`delete from posts where slug like 'e2e-editor-uploads%' or title ilike 'e2e editor uploads%'`
	);
	psql(`delete from "user" where email = '${READER_EMAIL}'`);
}

// Long serial chain owning a fixed fixture slug on the shared dev database -
// never run this file twice concurrently.
test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(() => {
	cleanup();
	psql(`delete from categories where id = '${CATEGORY}' or slug = 'e2e-editor-uploads-cat'`);
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', '${CATEGORY_NAME}', 'e2e-editor-uploads-cat') on conflict (id) do update set name = excluded.name, slug = excluded.slug`
	);
});

test.afterAll(() => {
	cleanup();
	psql(`delete from categories where slug = 'e2e-editor-uploads-cat'`);
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

/** Manual save (bypasses the server-side autosave throttle) + saved indicator. */
async function manualSave(page: Page) {
	await page.getByRole('button', { name: '保存草稿' }).click({ timeout: 5000 });
	await expect(byText(page, /已保存/)).toBeVisible({ timeout: 60000 });
}

function draftPayload(): string {
	return psql(`select content from drafts where slug = '${SLUG}'`);
}

async function openEditor(page: Page): Promise<string> {
	await expect
		.poll(() => psql(`select ref_id from drafts where slug = '${SLUG}'`), { timeout: 30000 })
		.toMatch(/^[0-9a-f-]{36}$/);
	const id = psql(`select ref_id from drafts where slug = '${SLUG}'`);
	await page.goto(`/admin/posts/edit?id=${id}`);
	await expect(page.locator('input[name="title"]')).toHaveValue(TITLE, { timeout: 15000 });
	return id;
}

async function openPicker(page: Page) {
	await page.locator('button[aria-label="插入图片"]').click();
	const dialog = page.getByRole('dialog', { name: '插入图片' });
	await expect(dialog).toBeVisible({ timeout: 10000 });
	return dialog;
}

function editorImages(page: Page): Locator {
	return page.locator('[data-lexical-editor="true"] img');
}

function pngFile(name: string) {
	return { name, mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') };
}

/** Synthesises a paste of local files on the editor root (real Chromium
 *  constructs ClipboardEvent with a clipboardData init). */
async function pasteFiles(page: Page, names: string[]) {
	await page.evaluate(
		({ b64, fileNames }) => {
			const root = document.querySelector('[data-lexical-editor="true"]');
			if (!root) throw new Error('editor root missing');
			const dataTransfer = new DataTransfer();
			for (const name of fileNames) {
				const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				dataTransfer.items.add(new File([bytes], name, { type: 'image/png' }));
			}
			root.dispatchEvent(
				new ClipboardEvent('paste', {
					bubbles: true,
					cancelable: true,
					clipboardData: dataTransfer
				})
			);
		},
		{ b64: PNG_B64, fileNames: names }
	);
}

async function dropFile(page: Page, name: string) {
	await page.evaluate(
		({ b64, fileName }) => {
			const root = document.querySelector('[data-lexical-editor="true"]');
			if (!root) throw new Error('editor root missing');
			const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const dataTransfer = new DataTransfer();
			dataTransfer.items.add(new File([bytes], fileName, { type: 'image/png' }));
			const rect = root.getBoundingClientRect();
			root.dispatchEvent(
				new DragEvent('drop', {
					bubbles: true,
					cancelable: true,
					dataTransfer,
					clientX: rect.left + 40,
					clientY: rect.top + 24
				})
			);
		},
		{ b64: PNG_B64, fileName: name }
	);
}

test('keeps the URL tab as the entry path (regression)', async ({ page }) => {
	await page.goto('/admin/posts/edit');
	const titleInput = page.locator('input[name="title"]');
	// Hydration gate: probe until the slug chip reacts (house pattern).
	await expect(async () => {
		await titleInput.click();
		await page.keyboard.type('probe');
		await expect(byText(page, '/probe')).toBeVisible({ timeout: 1500 });
	}).toPass({ timeout: 30000 });
	await titleInput.click();
	await page.keyboard.press('Control+A');
	await page.keyboard.type(TITLE);
	await pickCategory(page);

	const editor = page.getByRole('textbox', { name: '输入正文...' });
	await editor.click();
	await page.keyboard.type('intro line');

	const dialog = await openPicker(page);
	await dialog.getByLabel('图片地址').fill('https://e2e.example/pic.png');
	await dialog.getByRole('button', { name: '插入', exact: true }).click();
	await expect(dialog).toBeHidden({ timeout: 10000 });
	await expect(
		page.locator('[data-lexical-editor="true"] img[src="https://e2e.example/pic.png"]')
	).toHaveCount(1, { timeout: 10000 });

	await manualSave(page);
	expect(draftPayload()).toContain('](https://e2e.example/pic.png)');
});

test('uploads through the assets tab: @full level, dims in the markdown, anonymous reader served', async ({
	page,
	browser
}) => {
	await openEditor(page);
	const editor = page.getByRole('textbox', { name: '输入正文...' });
	await editor.click();
	await page.keyboard.press('Control+End');

	const dialog = await openPicker(page);
	await dialog.getByRole('tab', { name: '内容资产' }).click();
	const fileInput = dialog.locator('input[type="file"]');

	const before = await editorImages(page).count();
	await fileInput.setInputFiles(pngFile('e2e-upload-one.png'));
	await expect(editorImages(page)).toHaveCount(before + 1, { timeout: 30000 });
	await fileInput.setInputFiles({
		name: 'e2e-upload-loop.gif',
		mimeType: 'image/gif',
		buffer: Buffer.from(GIF_B64, 'base64')
	});
	await expect(editorImages(page)).toHaveCount(before + 2, { timeout: 30000 });
	await dialog.getByRole('button', { name: '取消' }).click();
	await expect(dialog).toBeHidden({ timeout: 10000 });

	await manualSave(page);
	const payload = draftPayload();
	// Existence rule (the P0 fix): a 1x1 source embeds as @full, dims ride the
	// tail attrs.
	expect(payload).toMatch(/\]\(\/i\/[A-Za-z0-9/._-]+\.png@full\) \{width=1 height=1\}/);
	// GIF pass-through keeps the bare key.
	expect(payload).toMatch(/\]\(\/i\/[A-Za-z0-9/._-]+\.gif\)/);

	const pngUrl = payload.match(/\]\((\/i\/[A-Za-z0-9/._-]+\.png@full)\)/)?.[1];
	const gifUrl = payload.match(/\]\((\/i\/[A-Za-z0-9/._-]+\.gif)\)/)?.[1];
	expect(pngUrl).toBeTruthy();
	expect(gifUrl).toBeTruthy();
	const anon = await browser.newContext();
	for (const url of [pngUrl!, gifUrl!]) {
		const response = await anon.request.get(`${ORIGIN}${url}`);
		expect(response.status(), url).toBe(200);
		expect(response.headers()['content-type']).toContain('image/');
	}
	await anon.close();
});

test('pastes three files at once: three uploads, three insertions (Q10)', async ({ page }) => {
	await openEditor(page);
	const editor = page.getByRole('textbox', { name: '输入正文...' });
	await editor.click();
	await page.keyboard.press('Control+End');

	const posts: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().includes('/admin/editor-uploads')) {
			posts.push(request.url());
		}
	});
	const before = await editorImages(page).count();
	await pasteFiles(page, ['e2e-paste-1.png', 'e2e-paste-2.png', 'e2e-paste-3.png']);
	await expect(editorImages(page)).toHaveCount(before + 3, { timeout: 60000 });
	await expect.poll(() => posts.length, { timeout: 30000 }).toBe(3);

	await manualSave(page);
	const payload = draftPayload();
	for (const n of [1, 2, 3]) expect(payload).toContain(`![e2e-paste-${n}]`);
});

test('shows the localized copy for a throttled upload (429)', async ({ page }) => {
	await openEditor(page);
	const editor = page.getByRole('textbox', { name: '输入正文...' });
	await editor.click();
	await page.keyboard.press('Control+End');

	await page.route('**/admin/editor-uploads', async (route) => {
		if (route.request().method() === 'POST') {
			await route.fulfill({
				status: 429,
				contentType: 'application/json',
				body: JSON.stringify({ code: 'throttled' })
			});
		} else {
			await route.continue();
		}
	});
	const before = await editorImages(page).count();
	await pasteFiles(page, ['e2e-throttled.png']);
	await expect(page.getByText('上传失败：操作太频繁，请稍后再试')).toBeVisible({ timeout: 15000 });
	expect(await editorImages(page).count()).toBe(before); // nothing inserted
	await page.unroute('**/admin/editor-uploads');
});

test('drops a file through the same pipeline', async ({ page }) => {
	await openEditor(page);
	const editor = page.getByRole('textbox', { name: '输入正文...' });
	await editor.click();
	await page.keyboard.press('Control+End');

	const before = await editorImages(page).count();
	await dropFile(page, 'e2e-drop-one.png');
	await expect(editorImages(page)).toHaveCount(before + 1, { timeout: 60000 });

	await manualSave(page);
	expect(draftPayload()).toContain('![e2e-drop-one]');
});

test('searches the assets source, shows the miss copy, and non-admins stay out (Q12)', async ({
	page,
	browser
}) => {
	await openEditor(page);
	const dialog = await openPicker(page);
	await dialog.getByRole('tab', { name: '内容资产' }).click();

	const search = dialog.getByRole('textbox', { name: '搜索名称…' });
	await search.fill('e2e-upload-one');
	await expect(dialog.getByRole('button', { name: 'e2e-upload-one.png' })).toBeVisible({
		timeout: 15000
	});
	await search.fill('zzz-nothing-matches');
	await expect(byText(page, '没有找到匹配的条目')).toBeVisible({ timeout: 15000 });

	// Clear the keyword first: the query is component state shared by both
	// panes, so a stale keyword would show the search-empty copy on the
	// photos pane instead of its own empty state.
	await search.fill('');
	// The photos source renders exactly one of its two states (the live
	// database may or may not carry visible photos).
	await dialog.getByRole('tab', { name: '图床' }).click();
	const tiles = dialog.locator('ul button');
	await expect(async () => {
		const tileCount = await tiles.count();
		if (tileCount > 0) {
			expect(tileCount).toBeGreaterThan(0);
		} else {
			await expect(byText(page, '图床里还没有照片。')).toBeVisible({ timeout: 2000 });
		}
	}).toPass({ timeout: 20000 });
	await dialog.getByRole('button', { name: '取消' }).click();
	await expect(dialog).toBeHidden({ timeout: 10000 });

	// A signed-in NON-admin session reaches no data surface on this endpoint
	// (the anonymous 401 arm lives in the route tests; loopback sessions are
	// auto-authenticated by design in this environment).
	const readerContext = await browser.newContext();
	await bootstrapReader(readerContext, READER_EMAIL, READER_PASSWORD);
	const response = await readerContext.request.get(`${ORIGIN}/admin/editor-uploads?source=files`, {
		maxRedirects: 0
	});
	expect(response.status()).toBe(403);
	expect(await response.json()).toEqual({ code: 'forbidden' });
	await readerContext.close();
});
