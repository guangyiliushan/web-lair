import { expect, test, type Page } from '@playwright/test';
import { byText, manualSave, psql } from './support';
import { zhCnLocale } from './locale-fixture';

/**
 * Reference lifecycle, live teeth (ST-3 3b1 + 3b2 draft identity, Q15 "T4
 * four paths"): draft save, publish, discard and page hard-delete maintain
 * `file_references` and the file status machine against the real database.
 * Since 3b2 the draft-phase refs are keyed `{draft, draftId}`: a save never
 * touches the published identity's set; publish re-keys the durable set and
 * drops the draft refs; discarding a working copy that merely dropped a
 * PUBLISHED image keeps the file attached (the interim 3b1 behavior detached
 * it - the flip to `detached` now needs the file to lose every reference,
 * which the scratch-database harness drives at the service level).
 */
test.use(zhCnLocale);

const CATEGORY = '00000000-0000-7000-8000-000000000022';
const CATEGORY_NAME = 'E2E Refs';
const POST_TITLE = 'e2e refs lifecycle';
const POST_SLUG = 'e2e-refs-lifecycle';
const NOTE_TITLE = 'e2e refs note';
const PAGE_TITLE = 'E2E Refs Page';
const PAGE_SLUG = 'e2e-refs-page';

// Valid 1x1 PNG, unique bytes on purpose: the registry is content-addressed,
// so sharing a fixture image with another spec would share its `files` row
// (and its references) across specs. The endpoint sniffs magic bytes; sharp
// decodes it.
const PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMQFJf9DwABxwFFFH1wbAAAAABJRU5ErkJggg==';
/** Bare object key learned from the first saved payload (serial file). */
let KEY = '';

function cleanup() {
	// Fallback for a run that crashed between deleting the draft rows and
	// this cleanup: those draft refs cannot be found through the drafts
	// subquery below any more, so also clear draft refs on this fixture's
	// own files (file names come from the fixture payloads).
	psql(
		`delete from file_references fr using files f where fr.file_id = f.id and fr.ref_type = 'draft' and f.file_name like 'e2e-refs%'`
	);
	// Draft-identity refs go with their draft rows (3b2); clean them first so
	// a crashed run cannot leave orphan reference rows behind.
	psql(
		`delete from file_references where ref_type = 'draft' and ref_id in (select id from drafts where title ilike 'e2e refs%' or ref_id in (select id from posts where slug like 'e2e-refs%') or ref_id in (select id from notes where slug like 'e2e-refs%') or ref_id in (select id from pages where slug = '${PAGE_SLUG}'))`
	);
	psql(`delete from drafts where title ilike 'e2e refs%'`);
	psql(`delete from drafts where ref_id in (select id from posts where slug like 'e2e-refs%')`);
	psql(`delete from drafts where ref_id in (select id from notes where slug like 'e2e-refs%')`);
	psql(
		`delete from drafts where ref_type = 'page' and ref_id in (select id from pages where slug = '${PAGE_SLUG}')`
	);
	// Match the same populations the row deletes below cover: placeholder
	// rows carry a `draft-` slug, so title must join the predicate or a
	// crashed run leaves orphan references behind (review round 2).
	psql(
		`delete from file_references where ref_type = 'post' and ref_id in (select id from posts where slug like 'e2e-refs%' or title ilike 'e2e refs lifecycle%')`
	);
	psql(
		`delete from file_references where ref_type = 'note' and ref_id in (select id from notes where slug like 'e2e-refs%' or title ilike 'e2e refs note%')`
	);
	psql(
		`delete from file_references where ref_type = 'page' and ref_id in (select id from pages where slug = '${PAGE_SLUG}')`
	);
	psql(`delete from slug_trackers where slug like 'e2e-refs%'`);
	psql(`delete from posts where slug like 'e2e-refs%' or title ilike 'e2e refs lifecycle%'`);
	psql(`delete from notes where slug like 'e2e-refs%' or title ilike 'e2e refs note%'`);
	psql(`delete from pages where slug = '${PAGE_SLUG}'`);
	// The files rows stay (content-addressed), but an attached row that just
	// lost its last reference must leave the attached state or audit check
	// (2) reports it after every run (ring-2 02-P3-3).
	psql(
		`update files set status = 'detached', detached_at = now(), updated_at = now() where file_name like 'e2e-refs%' and status = 'attached' and not exists (select 1 from file_references fr2 where fr2.file_id = files.id)`
	);
}

// A serial chain owning fixed fixture rows on the shared dev database - never
// run this file twice concurrently.
test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(() => {
	cleanup();
	psql(`delete from categories where id = '${CATEGORY}' or slug = 'e2e-refs-cat'`);
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', '${CATEGORY_NAME}', 'e2e-refs-cat') on conflict (id) do update set name = excluded.name, slug = excluded.slug`
	);
});

test.afterAll(() => {
	cleanup();
	psql(`delete from categories where slug = 'e2e-refs-cat'`);
});

/** Hydration gate: probe until the slug chip reacts (house pattern). */
async function fillTitle(page: Page, value: string) {
	const titleInput = page.locator('input[name="title"]');
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

/** Uploads the shared 1x1 PNG through the picker's assets tab. */
async function uploadViaPicker(page: Page) {
	await page.locator('button[aria-label="插入图片"]').click();
	const dialog = page.getByRole('dialog', { name: '插入图片' });
	await expect(dialog).toBeVisible({ timeout: 10000 });
	await dialog.getByRole('tab', { name: '内容资产' }).click();
	await dialog.locator('input[type="file"]').setInputFiles({
		name: 'e2e-refs.png',
		mimeType: 'image/png',
		buffer: Buffer.from(PNG_B64, 'base64')
	});
	// The thumbnail URL lives on an authenticated route; poll the inserted
	// image element itself instead.
	await expect(page.locator('[data-lexical-editor="true"] img').first()).toBeVisible({
		timeout: 30000
	});
	await dialog.getByRole('button', { name: '取消' }).click();
	await expect(dialog).toBeHidden({ timeout: 10000 });
}

function refCount(refType: string, refId: string): string {
	return psql(
		`select count(*) from file_references fr join files f on f.id = fr.file_id where f.object_key = '${KEY}' and fr.ref_type = '${refType}' and fr.ref_id = '${refId}'`
	);
}

function fileStatus(): string {
	return psql(`select status from files where object_key = '${KEY}'`);
}

function noteRefId(): string {
	return psql(
		`select coalesce((select ref_id from drafts where ref_type = 'note' and title = '${NOTE_TITLE}'), (select id from notes where title = '${NOTE_TITLE}'))`
	);
}

test('note draft autosave attaches the uploaded file under the DRAFT reference identity', async ({
	page
}) => {
	await page.goto('/admin/notes/edit');
	await fillTitle(page, NOTE_TITLE);
	await typeIntoEditor(page, 'refs note body');
	await uploadViaPicker(page);
	await manualSave(page);

	const payload = psql(`select content from drafts where title = '${NOTE_TITLE}'`);
	const match = payload.match(/\/i\/([0-9a-f]{2}\/[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?)/);
	expect(match).not.toBeNull();
	KEY = match![1];
	// Draft identity (3b2): the working copy's refs key on the DRAFT row; the
	// note's own identity stays untouched until publish.
	const noteDraftId = psql(`select id from drafts where title = '${NOTE_TITLE}'`);
	expect(refCount('draft', noteDraftId)).toBe('1');
	expect(refCount('note', noteRefId())).toBe('0');
	expect(fileStatus()).toBe('attached');
});

test('a second target shares the image (dedupe): both references live', async ({ page }) => {
	await page.goto('/admin/posts/edit');
	await fillTitle(page, POST_TITLE);
	await pickCategory(page);
	await typeIntoEditor(page, 'refs post body');
	await uploadViaPicker(page);
	await manualSave(page);

	const postId = psql(`select ref_id from drafts where slug = '${POST_SLUG}'`);
	const postDraftId = psql(`select id from drafts where slug = '${POST_SLUG}'`);
	// Both saves wrote under their DRAFT identities; the target identities
	// have not been touched (3b2).
	expect(refCount('draft', postDraftId)).toBe('1');
	expect(refCount('post', postId)).toBe('0');
	expect(refCount('draft', psql(`select id from drafts where title = '${NOTE_TITLE}'`))).toBe('1');
	expect(fileStatus()).toBe('attached');
});

test('discarding a working copy drops its references; the other target keeps the file attached', async ({
	page
}) => {
	const postId = psql(`select ref_id from drafts where slug = '${POST_SLUG}'`);
	// Captured while the draft row still exists (the discard deletes it).
	const postDraftId = psql(`select id from drafts where slug = '${POST_SLUG}'`);
	await page.goto('/admin/drafts');
	const row = page.getByRole('row').filter({ hasText: POST_TITLE });
	await expect(row.first()).toBeVisible({ timeout: 10000 });
	await expect(async () => {
		await row.first().getByRole('button', { name: '丢弃草稿' }).click();
		await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20000 });
	await page.getByRole('button', { name: '丢弃', exact: true }).click();
	await expect(byText(page, '草稿已丢弃。')).toBeVisible({ timeout: 15000 });

	// The never-published placeholder goes with its draft AND the draft's
	// own refs leave with the row (3b2); the note draft's reference keeps
	// the shared file attached (the two-targets edge).
	expect(psql(`select count(*) from drafts where ref_id = '${postId}'`)).toBe('0');
	expect(psql(`select count(*) from posts where id = '${postId}'`)).toBe('0');
	expect(refCount('post', postId)).toBe('0');
	expect(
		psql(
			`select count(*) from file_references where ref_type = 'draft' and ref_id = '${postDraftId}'`
		)
	).toBe('0');
	expect(refCount('draft', psql(`select id from drafts where title = '${NOTE_TITLE}'`))).toBe('1');
	expect(fileStatus()).toBe('attached');
});

test('page hard-delete clears its references inside the delete transaction', async ({ page }) => {
	psql(
		`insert into pages (slug, title, content, content_format) values ('${PAGE_SLUG}', '{"en":"${PAGE_TITLE}"}'::jsonb, '{"en":"fixture /i/${KEY}@full body"}'::jsonb, 'markdown')`
	);
	const pageId = psql(`select id from pages where slug = '${PAGE_SLUG}'`);
	psql(
		`insert into file_references (file_id, ref_type, ref_id) select id, 'page', '${pageId}' from files where object_key = '${KEY}'`
	);
	expect(refCount('page', pageId)).toBe('1');

	await page.goto('/admin/pages');
	const row = page.getByRole('row').filter({ hasText: PAGE_TITLE });
	await expect(row.first()).toBeVisible({ timeout: 15000 });
	await row.first().getByRole('button', { name: '删除' }).click();
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible({ timeout: 10000 });
	await dialog.getByRole('button', { name: '删除', exact: true }).click();
	await expect(page.getByRole('row').filter({ hasText: PAGE_TITLE })).toHaveCount(0, {
		timeout: 15000
	});

	expect(psql(`select count(*) from pages where slug = '${PAGE_SLUG}'`)).toBe('0');
	expect(refCount('page', pageId)).toBe('0');
	expect(refCount('draft', psql(`select id from drafts where title = '${NOTE_TITLE}'`))).toBe('1');
	expect(fileStatus()).toBe('attached');
});

test('publish keeps the reference set of the published body', async ({ page }) => {
	const noteId = noteRefId();
	const noteDraftId = psql(`select id from drafts where title = '${NOTE_TITLE}'`);
	await page.goto(`/admin/notes/edit?id=${noteId}`);
	await expect(page.locator('input[name="title"]')).toHaveValue(NOTE_TITLE, { timeout: 15000 });
	// Empty-tooth guard (review): clear the note-identity set so only the
	// publish sync can fill it - deleting the publish sync leaves this red.
	// (3b2: draft saves write the DRAFT identity, so this delete only bites
	// legacy note-identity rows; the refCount below reads on the result.)
	psql(`delete from file_references where ref_type = 'note' and ref_id = '${noteId}'`);
	expect(refCount('note', noteId)).toBe('0');
	await expect(async () => {
		await page.getByRole('button', { name: '发布' }).click();
		await page.waitForURL(/published=1/, { timeout: 15000 });
	}).toPass({ timeout: 30000 });

	expect(psql(`select count(*) from drafts where ref_id = '${noteId}'`)).toBe('0');
	expect(refCount('note', noteId)).toBe('1');
	// The draft's own refs left with the row (3b2).
	expect(
		psql(
			`select count(*) from file_references where ref_type = 'draft' and ref_id = '${noteDraftId}'`
		)
	).toBe('0');
	expect(fileStatus()).toBe('attached');
});

test('dropping the image from the working copy keeps the published reference attached', async ({
	page
}) => {
	const noteId = noteRefId();
	await page.goto(`/admin/notes/edit?id=${noteId}`);
	await expect(page.locator('input[name="title"]')).toHaveValue(NOTE_TITLE, { timeout: 15000 });
	// The reopened working copy renders the image (CRLF-safe import: a
	// FormData-normalized `\r\n` used to degrade this line to link text).
	await expect(page.locator('[data-lexical-editor="true"] img')).toHaveCount(1, {
		timeout: 15000
	});
	// Remove the image through code mode: drop the image line, leave code mode
	// (the rich editor rebuilds from the edited markdown), then save.
	await page.getByRole('button', { name: '切换到代码模式' }).click();
	const codeArea = page.getByRole('textbox', { name: '输入正文...' });
	await expect(codeArea).toBeVisible({ timeout: 10000 });
	const markdown = await codeArea.inputValue();
	expect(markdown).toContain('/i/');
	const stripped = markdown
		.split('\n')
		.filter((line) => !line.includes('/i/'))
		.join('\n')
		.trim();
	await codeArea.fill(stripped);
	await page.getByRole('button', { name: '切换到富文本模式' }).click();
	await expect(page.locator('[data-lexical-editor="true"] img')).toHaveCount(0, {
		timeout: 15000
	});
	await manualSave(page);

	// 3b2 flip: the working copy's refs are its own - dropping the image from
	// the DRAFT no longer detaches a file the PUBLISHED body still references
	// (the interim 3b1 behavior did, protected only by the mention scan). The
	// published identity keeps the key; the fresh working copy wrote nothing.
	const workingDraftId = psql(`select id from drafts where ref_id = '${noteId}'`);
	expect(refCount('draft', workingDraftId)).toBe('0');
	expect(refCount('note', noteId)).toBe('1');
	expect(fileStatus()).toBe('attached');
	expect(psql(`select detached_at is not null from files where object_key = '${KEY}'`)).toBe('f');
});

test('a page draft keys the upload under its draft identity; publish re-keys it (P5)', async ({
	page
}) => {
	// A plain md row (no image) as the edit target; the upload below enters
	// through the editor's picker, exactly like a writer's flow. The route
	// and the draft chain are the P5 additions (the old direct form never
	// had one).
	psql(
		`insert into pages (slug, title, content, content_format) values ('${PAGE_SLUG}', '{"en":"${PAGE_TITLE}"}'::jsonb, '{"en":"fixture page body"}'::jsonb, 'markdown')`
	);
	const pageId = psql(`select id from pages where slug = '${PAGE_SLUG}'`);

	await page.goto(`/admin/pages/edit?id=${pageId}`);
	await expect(page.getByRole('textbox', { name: /写下你的页面/ })).toBeVisible({
		timeout: 15_000
	});
	await uploadViaPicker(page);
	await manualSave(page);

	// Draft identity (3b2): the editor's working copy keys the ref on its
	// draft row; the page identity stays untouched until publish.
	const draftId = psql(`select id from drafts where ref_type = 'page' and ref_id = '${pageId}'`);
	expect(draftId).not.toBe('');
	expect(refCount('draft', draftId)).toBe('1');
	expect(refCount('page', pageId)).toBe('0');
	expect(fileStatus()).toBe('attached');

	// Publish copies the localized body (keysFromLocalizedContent union) and
	// re-keys the durable reference set onto the page identity; the draft's
	// own refs leave with its row.
	await expect(async () => {
		// Idempotent retry (R2-7): a landed publish must not be re-clicked -
		// the draft row is gone by then and the retry would 404 forever.
		if (psql(`select count(*) from drafts where ref_id = '${pageId}'`) === '0') return;
		await page.getByRole('button', { name: '发布' }).click();
		await page.waitForURL(/published=1/, { timeout: 20_000 });
	}).toPass({ timeout: 40_000 });
	expect(psql(`select count(*) from drafts where ref_id = '${pageId}'`)).toBe('0');
	expect(refCount('page', pageId)).toBe('1');
	expect(
		psql(`select count(*) from file_references where ref_type = 'draft' and ref_id = '${draftId}'`)
	).toBe('0');
	expect(fileStatus()).toBe('attached');
});
