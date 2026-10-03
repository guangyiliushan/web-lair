import { expect, test, type Locator, type Page } from '@playwright/test';
import { psql } from './support';

/**
 * N1 admin chain (batch 5) - owner flow against the real notes editor, the
 * real database and the real publish transaction:
 *
 *   autosave -> reload restore -> publish -> front page renders -> list row
 *   -> topics CRUD (create / edit / reorder / attribution refusal / delete)
 *   -> row-level settings (pin / password / emotions) -> trash 404 + restore.
 *
 * The localhost origin auto-authenticates as the site owner (see auth.e2e.ts /
 * TAILSCALE_ALLOW_LOOPBACK). Notes draft saves share the posts throttle (one
 * write per 30s per draft), so steps wait for the visible save indicator.
 */
const TOPIC = '00000000-0000-7000-8000-000000000030';
const TOPIC_NAME = 'E2E Topic';
const TOPIC2_NAME = 'E2E Topic 2';
const TOPIC2_SLUG = 'e2e-topic-2';
const TITLE = 'e2e note alpha';
const SLUG = 'e2e-note-alpha';

function byText(page: Page, text: string | RegExp): Locator {
	return page.getByText(text).filter({ visible: true });
}

function cleanup() {
	psql(`delete from drafts where slug like 'e2e-note%'`);
	psql(`delete from drafts where ref_id in (select id from notes where slug like 'e2e-note%')`);
	psql(`delete from slug_trackers where slug like 'e2e-note%'`);
	psql(`delete from notes where slug like 'e2e-note%' or title ilike 'e2e note%'`);
	psql(`delete from topics where slug like 'e2e-topic%'`);
}

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(() => {
	cleanup();
	// Idempotent fixture topic (mirrors the posts e2e category fixture).
	psql(
		`insert into topics (id, name, slug, sort_order) values ('${TOPIC}', '${TOPIC_NAME}', 'e2e-topic', 0) on conflict (id) do update set name = excluded.name, slug = excluded.slug`
	);
});

test.afterAll(() => {
	cleanup();
});

/** Open the editor settings sheet (idempotent across enhance reloads). */
async function openSheet(page: Page) {
	await expect(async () => {
		if (!(await page.locator('#settings-topic').isVisible())) {
			await page.getByRole('button', { name: '手记设置' }).click();
		}
		await expect(page.locator('#settings-topic')).toBeVisible({ timeout: 10000 });
	}).toPass({ timeout: 20000 });
}

/** Pick the fixture topic inside the settings sheet (retry under load). */
async function pickTopic(page: Page) {
	await openSheet(page);
	await expect(async () => {
		await page.locator('#settings-topic').click();
		await page
			.locator('[data-slot="select-item"]')
			.filter({ hasText: TOPIC_NAME })
			.first()
			.click({ timeout: 3000 });
		await expect(page.locator('#settings-topic')).toContainText(TOPIC_NAME, {
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
	// chip) reacts (same finding as the posts editor spec).
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

function noteId(): string {
	// Before publish the real slug lives on the DRAFT row (the notes row is a
	// draft-xxxx placeholder); after publish the draft is gone and the slug is
	// on the notes row. Read whichever side currently owns it.
	return psql(
		`select coalesce((select ref_id from drafts where slug = '${SLUG}'), (select id from notes where slug = '${SLUG}'))`
	);
}

test('autosaves a new note and restores it after a reload', async ({ page }) => {
	await page.goto('/admin/notes/edit');
	await fillTitle(page, TITLE);
	// CJK-safe slug rule: the latin title derives kebab-cased.
	await expect(byText(page, `/${SLUG}`)).toBeVisible({ timeout: 10000 });

	// Pick the topic first so the first autosave carries it (the 30s throttle
	// would otherwise stage the topic change a second save window later).
	await pickTopic(page);
	await typeIntoEditor(page, 'Hello notes body');
	// The visible "已保存" can belong to an earlier autosave (the first one
	// fires while the title is still the hydration probe); poll the database
	// for the final working copy instead of racing the indicator.
	await expect
		.poll(() => psql(`select count(*) from drafts where slug = '${SLUG}'`), { timeout: 90000 })
		.toBe('1');
	expect(
		psql(
			`select n.lang || '/' || n.status from notes n join drafts d on d.ref_id = n.id where d.slug = '${SLUG}'`
		)
	).toBe('en/draft');
	// Metadata (topic / mood / weather...) lives on the draft row until the
	// publish transaction copies it onto the note (editor model, §9.10).
	expect(psql(`select topic_id = '${TOPIC}' from drafts where slug = '${SLUG}'`)).toBe('t');

	await expect.poll(() => page.url()).toContain('id=');
	await page.reload();
	await expect(page.locator('input[name="title"]')).toHaveValue(TITLE, { timeout: 10000 });
	await expect(page.getByRole('textbox', { name: '输入正文...' })).toContainText(
		'Hello notes body'
	);
});

test('publishes the draft: notes row, front page and admin list', async ({ page }) => {
	const id = noteId();
	await page.goto(`/admin/notes/edit?id=${id}`);
	await expect(page.locator('input[name="title"]')).toHaveValue(TITLE, { timeout: 10000 });

	// Click + outcome as one retryable step: a pre-hydration click is a no-op.
	await expect(async () => {
		await page.getByRole('button', { name: '发布' }).click();
		await expect(byText(page, /已发布/).first()).toBeVisible({ timeout: 2500 });
	}).toPass({ timeout: 60000 });

	expect(psql(`select status from notes where slug = '${SLUG}'`)).toBe('published');
	expect(psql(`select count(*) from drafts where ref_id = '${id}'`)).toBe('0');
	expect(psql(`select content ilike '%Hello notes body%' from notes where slug = '${SLUG}'`)).toBe(
		't'
	);

	// Front page renders the published note.
	await page.goto(`/en/notes/${SLUG}`);
	await expect(page.getByRole('heading', { name: TITLE })).toBeVisible({ timeout: 15000 });

	// Admin list shows the row.
	await page.goto('/admin/notes');
	await expect(byText(page, TITLE)).toBeVisible({ timeout: 15000 });
});

test('topics CRUD: create, edit, reorder, attribution refusal, delete', async ({ page }) => {
	await page.goto('/admin/notes/topics');

	// Create (retry the click until the dialog actually opens - a
	// pre-hydration click is a silent no-op under full-suite load).
	await expect(async () => {
		if (!(await page.locator('#topic-name').isVisible())) {
			await page.getByRole('button', { name: '新建' }).filter({ visible: true }).first().click();
		}
		await expect(page.locator('#topic-name')).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30000 });
	await page.locator('#topic-name').fill(TOPIC2_NAME);
	await expect(page.locator('#topic-slug')).toHaveValue(TOPIC2_SLUG);
	await page.getByRole('button', { name: '创建' }).click();
	await expect(byText(page, TOPIC2_NAME)).toBeVisible({ timeout: 10000 });
	expect(psql(`select count(*) from topics where slug = '${TOPIC2_SLUG}'`)).toBe('1');

	// Edit description through the dialog.
	await byText(page, TOPIC2_NAME).first().click();
	await page.getByRole('button', { name: '编辑' }).filter({ visible: true }).first().click();
	await page.locator('#topic-description').fill('e2e description');
	await page.getByRole('button', { name: '保存' }).click();
	await expect
		.poll(() => psql(`select description from topics where slug = '${TOPIC2_SLUG}'`))
		.toBe('e2e description');

	// Reorder: one ▲ moves it one slot earlier; ▼ returns it.
	const slugOrder = () =>
		psql(`select string_agg(slug, ',' order by sort_order, name) from topics`);
	const indexBefore = slugOrder().split(',').indexOf(TOPIC2_SLUG);
	await page.getByRole('button', { name: '上移' }).click();
	await expect.poll(() => slugOrder().split(',').indexOf(TOPIC2_SLUG)).toBe(indexBefore - 1);
	await page.getByRole('button', { name: '下移' }).click();
	await expect.poll(() => slugOrder().split(',').indexOf(TOPIC2_SLUG)).toBe(indexBefore);

	// Delete refusal: the fixture topic still owns the published note.
	await page.getByText(TOPIC_NAME, { exact: true }).filter({ visible: true }).first().click();
	await page.getByRole('button', { name: '删除' }).filter({ visible: true }).first().click();
	await expect(byText(page, /仍有/)).toBeVisible({ timeout: 10000 });
	expect(psql(`select count(*) from topics where slug = 'e2e-topic'`)).toBe('1');

	// Delete the note-free topic.
	await page.getByText(TOPIC2_NAME, { exact: true }).filter({ visible: true }).first().click();
	await page.getByRole('button', { name: '删除' }).filter({ visible: true }).first().click();
	await expect
		.poll(() => psql(`select count(*) from topics where slug = '${TOPIC2_SLUG}'`))
		.toBe('0');
});

test('row-level settings: pin, password and emotions', async ({ page }) => {
	const id = noteId();
	await page.goto(`/admin/notes/edit?id=${id}`);
	await openSheet(page);

	// Pin.
	await page.getByRole('button', { name: '置顶', exact: true }).click();
	await expect
		.poll(() => psql(`select pin_at is not null from notes where slug = '${SLUG}'`))
		.toBe('t');
	await expect(byText(page, '取消置顶')).toBeVisible({ timeout: 10000 });

	// Password gate arm.
	await page.locator('input[name="password"]').fill('e2e-pass-4567');
	await page.getByRole('button', { name: '保存', exact: true }).click();
	await expect(byText(page, /已设置密码/)).toBeVisible({ timeout: 10000 });
	expect(psql(`select password_hash is not null from notes where slug = '${SLUG}'`)).toBe('t');

	// Emotions (one token is enough to prove the round trip).
	const emotionForm = page.locator('form[action="?/emotions"]');
	await emotionForm.locator('input[type="checkbox"]').first().check();
	await page.getByRole('button', { name: '保存情绪选择' }).click();
	await expect
		.poll(() =>
			psql(
				`select coalesce(jsonb_array_length(meta -> 'emotions'), 0) from notes where slug = '${SLUG}'`
			)
		)
		.toBe('1');
});

/** Type a title until the input truly holds it (pre-hydration keystrokes are lost). */
async function setTitle(page: Page, value: string) {
	const titleInput = page.locator('input[name="title"]');
	await expect(async () => {
		await titleInput.click();
		await page.keyboard.press('Control+A');
		await page.keyboard.type(value);
		await expect(titleInput).toHaveValue(value, { timeout: 1500 });
	}).toPass({ timeout: 30000 });
}

/** Manual save + wait for the saved indicator (manual saves bypass the throttle). */
async function saveDraft(page: Page) {
	await page.getByRole('button', { name: '保存草稿' }).click();
	await expect(byText(page, /已保存/).first()).toBeVisible({ timeout: 30000 });
}

test('trash removes the note from the front; restore brings it back', async ({ page }) => {
	const id = noteId();

	await page.goto(`/admin/notes/edit?id=${id}`);
	await openSheet(page);
	await page.getByRole('button', { name: '移入回收站' }).click();
	await expect.poll(() => psql(`select status from notes where slug = '${SLUG}'`)).toBe('trash');

	const trashed = await page.goto(`/en/notes/${SLUG}`);
	expect(trashed?.status()).toBe(404);

	await page.goto(`/admin/notes/edit?id=${id}`);
	await openSheet(page);
	await page.getByRole('button', { name: '从回收站恢复' }).click();
	await expect(byText(page, '已从回收站恢复')).toBeVisible({ timeout: 15000 });
	await expect
		.poll(() => psql(`select status from notes where slug = '${SLUG}'`))
		.toBe('published');

	const live = await page.goto(`/en/notes/${SLUG}`);
	expect(live?.status()).toBe(200);
});

test('a stale tab hits the 409 conflict banner and can reload the server state', async ({
	context
}) => {
	const id = noteId();
	const tabA = await context.newPage();
	const tabB = await context.newPage();
	await tabA.goto(`/admin/notes/edit?id=${id}`);
	await tabB.goto(`/admin/notes/edit?id=${id}`);
	await expect(tabA.locator('input[name="title"]')).toHaveValue(/.+/, { timeout: 10000 });
	await expect(tabB.locator('input[name="title"]')).toHaveValue(/.+/, { timeout: 10000 });

	// Tab A saves first (creates/advances the draft); tab B reloads to hold it.
	await setTitle(tabA, 'e2e note alpha v1');
	await saveDraft(tabA);
	await tabB.goto(`/admin/notes/edit?id=${id}`);
	await expect(tabB.locator('input[name="title"]')).toHaveValue('e2e note alpha v1');

	// Tab A advances the draft; tab B's stale version must NOT overwrite it.
	await setTitle(tabA, 'e2e note alpha v2');
	await saveDraft(tabA);
	await setTitle(tabB, 'e2e note alpha v3');
	await tabB.getByRole('button', { name: '保存草稿' }).click();
	await expect(byText(tabB, /内容已在其他窗口更新/).first()).toBeVisible({ timeout: 30000 });

	// The banner's reload adopts the server copy (tab A's write survives).
	await tabB.getByRole('button', { name: '载入服务端最新' }).click();
	await expect(tabB.locator('input[name="title"]')).toHaveValue('e2e note alpha v2', {
		timeout: 10000
	});
	expect(psql(`select title from drafts where ref_id = '${id}'`)).toBe('e2e note alpha v2');
	await tabA.close();
	await tabB.close();
});
