import { expect, test, type Page } from '@playwright/test';
import { byText, manualSave, psql } from './support';
import { zhCnLocale } from './locale-fixture';

test.use(zhCnLocale);

/**
 * pages-line acceptance: P2 registry (T6) + P5 md editor draft flow (T10) +
 * route resolution (T11), against the real page and the real database. The
 * localhost origin auto-authenticates as the site owner (same as
 * auth.e2e.ts / TAILSCALE_ALLOW_LOOPBACK in the playwright webServer env).
 *
 * Fixtures live under `e2e-admin-%`; the editor-created pages additionally
 * carry `E2E Admin` titles (their placeholder slugs are `draft-…` until the
 * publish), so cleanup keys on the draft payload titles for those.
 */

const SLUG_A = 'e2e-admin-a';
const SLUG_A2 = 'e2e-admin-a2';
const SLUG_B = 'e2e-admin-b';
const TITLE_A = 'E2E Admin A';
const TITLE_A_ZH = 'E2E 管理页甲';
const TITLE_B = 'E2E Admin B';
const NEW_SLUG = 'e2e-admin-new';
const NEW_TITLE_EN = 'E2E Admin New';
const NEW_TITLE_ZH = 'E2E 管理页新页';

let idA = '';
let idB = '';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

function cleanup(): void {
	// Order matters: draft-identity refs first, then the editor-created
	// placeholder rows (found through the draft payloads while those rows
	// exist), then the fixture rows themselves. Draft matching is by raw
	// payload text (R2-7): locale-agnostic, so an env whose default_lang is
	// not `en` cannot leak fixtures behind the `->>'en'` slot.
	psql(
		`delete from file_references where ref_type = 'draft' and ref_id in (select id from drafts where ref_type = 'page' and payload::text like '%E2E Admin%')`
	);
	psql(
		`delete from pages where slug like 'draft-%' and id in (select ref_id from drafts where ref_type = 'page' and payload::text like '%E2E Admin%')`
	);
	psql(
		`delete from file_references where ref_type = 'page' and ref_id in (select id from pages where slug like 'e2e-admin-%')`
	);
	psql(`delete from drafts where ref_type = 'page' and payload::text like '%E2E Admin%'`);
	psql(`delete from pages where slug like 'e2e-admin-%'`);
}

test.beforeAll(() => {
	// Effective default language (G4; rebuilt-DB reality): the live DB was
	// rebuilt without the options row, and the app's registry fallback is
	// 'en' - assert the EFFECTIVE value so a deliberate drift to another
	// locale still fails here.
	expect(
		psql(
			`select coalesce((select value #>> '{}' from options where name = 'site.default_lang'), 'en')`
		)
	).toBe('en');
	cleanup();
	psql(
		`insert into pages (slug, title, description, icon, external_url, status, sort_order, is_default, content, content_format) values ('${SLUG_A}', '{"en":"${TITLE_A}","zh-cn":"${TITLE_A_ZH}"}'::jsonb, null, null, null, 'visible', 0, false, '{"en":"# E2E admin body A","zh-cn":"# E2E 管理页甲正文"}'::jsonb, 'markdown')`
	);
	psql(
		`insert into pages (slug, title, description, icon, external_url, status, sort_order, is_default, content, content_format) values ('${SLUG_B}', '{"en":"${TITLE_B}"}'::jsonb, null, null, null, 'visible', 61, false, '{"en":"# E2E admin body B"}'::jsonb, 'markdown')`
	);
	idA = psql(`select id from pages where slug = '${SLUG_A}'`);
	idB = psql(`select id from pages where slug = '${SLUG_B}'`);
	// Cleanup + seed must leave exactly the two fixtures behind.
	expect(psql(`select count(*) from pages where slug like 'e2e-admin-%'`)).toBe('2');
});

test.afterAll(() => {
	cleanup();
});

function row(page: Page, text: string) {
	return page.getByRole('row').filter({ hasText: text });
}

async function rowIndex(page: Page, text: string): Promise<number> {
	return page.$$eval(
		'table tbody tr',
		(rows, needle) => rows.findIndex((r) => (r.textContent ?? '').includes(needle)),
		text
	);
}

const aFirst = async (page: Page) =>
	(await rowIndex(page, TITLE_A_ZH)) < (await rowIndex(page, TITLE_B));
const bFirst = async (page: Page) =>
	(await rowIndex(page, TITLE_B)) < (await rowIndex(page, TITLE_A_ZH));

/** Open the slug dialog (if needed), set the value, confirm. */
async function setSlug(page: Page, value: string) {
	await expect(async () => {
		if (!(await page.locator('input[name="slug-input"]').isVisible())) {
			await page.getByRole('button', { name: '添加 slug' }).click();
		}
		await expect(page.locator('input[name="slug-input"]')).toBeVisible({ timeout: 5000 });
	}).toPass({ timeout: 30_000 });
	await page.locator('input[name="slug-input"]').fill(value);
	await page.getByRole('button', { name: '确定' }).click();
	await expect(page.locator('input[name="slug-input"]')).toBeHidden({ timeout: 5000 });
}

/** Type into the PAGES editor body (its placeholder is the pages copy). */
async function typeIntoPageEditor(page: Page, text: string) {
	const editor = page.getByRole('textbox', { name: /写下你的页面/ });
	await expect(editor).toBeVisible({ timeout: 15_000 });
	const probe = text.trim().split(/\s+/)[0];
	await expect(async () => {
		const current = await editor.innerText();
		if (!current.includes(probe)) {
			await editor.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.type(text);
		}
		await expect(editor).toContainText(probe, { timeout: 2000 });
	}).toPass({ timeout: 30_000 });
}

test('the registry lists defaults first, tags the fixtures, and opens the dual-type New menu', async ({
	page
}) => {
	await page.goto('/admin/pages');
	await expect(page.getByText(/共 \d+ 页/)).toBeVisible();
	await expect(row(page, TITLE_A_ZH)).toBeVisible();
	await expect(row(page, TITLE_B)).toBeVisible();
	await expect(row(page, '关于我').getByText('默认')).toBeVisible();
	await expect(row(page, TITLE_A_ZH).getByText('默认')).toHaveCount(0);
	// The defaults pin outranks sort_order: A sorts at 0 yet stays below.
	expect(await rowIndex(page, '关于我')).toBeLessThan(await rowIndex(page, TITLE_A_ZH));
	// 「新增」双类型 (P5-3): the toolbar menu offers the md editor target and
	// the direct external-entry dialog.
	await expect(async () => {
		await page.getByRole('button', { name: '新建' }).click();
		await expect(page.getByRole('menuitem', { name: 'md 页面' })).toBeVisible({
			timeout: 3000
		});
	}).toPass({ timeout: 30_000 });
	await expect(page.getByRole('menuitem', { name: '外链' })).toBeVisible();
	await page.keyboard.press('Escape');
});

test('▲/▼ reorders the fixture pair inside one list renumber', async ({ page }) => {
	await page.goto('/admin/pages');
	await expect(row(page, TITLE_A_ZH)).toBeVisible();
	await expect.poll(() => aFirst(page)).toBe(true);

	// Condition-guarded clicks: a hydration-swallowed first click retries
	// without ever double-toggling (the inner poll absorbs the invalidate).
	await expect(async () => {
		if (!(await bFirst(page))) {
			await row(page, TITLE_B).getByRole('button', { name: '上移' }).click();
		}
		await expect.poll(() => bFirst(page), { timeout: 8000 }).toBe(true);
	}).toPass({ timeout: 40_000 });

	await expect(async () => {
		if (!(await aFirst(page))) {
			await row(page, TITLE_B).getByRole('button', { name: '下移' }).click();
		}
		await expect.poll(() => aFirst(page), { timeout: 8000 }).toBe(true);
	}).toPass({ timeout: 40_000 });
});

test('the eye toggle flips a row between visible and hidden', async ({ page }) => {
	await page.goto('/admin/pages');
	const rowA = row(page, TITLE_A_ZH);
	await expect(rowA.getByText('可见')).toBeVisible();

	await expect(async () => {
		if ((await rowA.getByText('隐藏', { exact: true }).count()) === 0) {
			await rowA.getByRole('button', { name: '隐藏' }).click();
		}
		await expect
			.poll(() => rowA.getByText('隐藏', { exact: true }).isVisible(), {
				timeout: 8000
			})
			.toBe(true);
	}).toPass({ timeout: 40_000 });

	await expect(async () => {
		if ((await rowA.getByText('可见', { exact: true }).count()) === 0) {
			await rowA.getByRole('button', { name: '显示' }).click();
		}
		await expect
			.poll(() => rowA.getByText('可见', { exact: true }).isVisible(), {
				timeout: 8000
			})
			.toBe(true);
	}).toPass({ timeout: 40_000 });
});

test('default rows expose no delete and fold hiding behind a confirmation', async ({ page }) => {
	await page.goto('/admin/pages');
	const rowAbout = row(page, '关于我');
	await expect(rowAbout).toBeVisible();
	await expect(rowAbout.getByRole('button', { name: '删除' })).toHaveCount(0);

	await expect(async () => {
		if ((await page.getByText('隐藏默认页？').count()) === 0) {
			await rowAbout.getByRole('button', { name: '隐藏' }).click();
		}
		await expect(page.getByText('隐藏默认页？')).toBeVisible({ timeout: 5000 });
	}).toPass({ timeout: 30_000 });

	await page.getByRole('button', { name: '取消' }).click();
	await expect(page.getByText('隐藏默认页？')).toBeHidden();
	await expect(rowAbout.getByText('可见')).toBeVisible();
});

test('the editor publishes a draft with a localized title and blocks reserved slugs', async ({
	page
}) => {
	await page.goto(`/admin/pages/edit?id=${idA}`);
	await expect(page.getByText('额外页')).toBeVisible();
	await expect(page.getByText('md 页面')).toBeVisible();
	await expect(byText(page, `/${SLUG_A}`)).toBeVisible();

	// Reserved slugs are refused AT PUBLISH (the draft flow validates inside
	// the publish transaction, not on the retired direct form).
	await expect(async () => {
		await page.goto(`/admin/pages/edit?id=${idA}`);
		await setSlug(page, 'admin');
		await page.getByRole('button', { name: '发布' }).click();
		await expect(page.getByRole('alert')).toContainText('保留词', { timeout: 20_000 });
	}).toPass({ timeout: 120_000 });
	expect(psql(`select slug from pages where id = '${idA}'`)).toBe(SLUG_A);

	// Fix the slug, edit the zh-cn title through the locale switcher, then
	// publish: the draft merges per language and the row lands renamed.
	await expect(async () => {
		// Idempotent retry (P5-5 T7): an attempt that already landed must not
		// re-run against the post-publish state.
		if (psql(`select slug from pages where id = '${idA}'`) === SLUG_A2) return;
		await page.goto(`/admin/pages/edit?id=${idA}`);
		await setSlug(page, SLUG_A2);
		// Locale switch signal: the title input swaps to the seeded zh-cn
		// title; a swallowed click keeps the en title and fails the gate.
		const titleInput = page.locator('input[aria-label="标题"]');
		await expect(async () => {
			await page.getByRole('button', { name: '简体中文' }).click();
			await expect(titleInput).toHaveValue(TITLE_A_ZH, { timeout: 3000 });
		}).toPass({ timeout: 30_000 });
		await expect(async () => {
			await titleInput.click();
			await page.keyboard.press('Control+A');
			await page.keyboard.type('E2E 管理页甲改');
			await expect(titleInput).toHaveValue('E2E 管理页甲改', { timeout: 2000 });
		}).toPass({ timeout: 30_000 });
		await page.getByRole('button', { name: '发布' }).click();
		await page.waitForURL(/published=1/, { timeout: 20_000 });
	}).toPass({ timeout: 150_000 });

	expect(psql(`select title->>'zh-cn' from pages where id = '${idA}'`)).toBe('E2E 管理页甲改');
	expect(psql(`select slug from pages where id = '${idA}'`)).toBe(SLUG_A2);
	// Divergence 4: pages keep NO slug tracker (no 301 by decision).
	expect(psql(`select count(*) from slug_trackers where slug = '${SLUG_A}'`)).toBe('0');

	// The renamed slug serves; the old one is gone (no 301 by decision).
	const old = await page.goto(`/zh-cn/${SLUG_A}`);
	expect(old?.status()).toBe(404);
	const fresh = await page.goto(`/zh-cn/${SLUG_A2}`);
	expect(fresh?.status()).toBe(200);
	await expect(page.getByRole('heading', { name: 'E2E 管理页甲改' }).first()).toBeVisible();
});

test('the default row keeps a read-only slug in the dialog', async ({ page }) => {
	const aboutId = psql(`select id from pages where slug = 'about'`);
	await page.goto(`/admin/pages/edit?id=${aboutId}`);
	await expect(async () => {
		if (!(await page.locator('input[name="slug-input"]').isVisible())) {
			await page.getByRole('button', { name: '添加 slug' }).click();
		}
		await expect(page.locator('input[name="slug-input"]')).toBeVisible({ timeout: 5000 });
	}).toPass({ timeout: 30_000 });
	await expect(page.locator('input[name="slug-input"]')).toHaveAttribute('readonly', '');
	await expect(byText(page, /默认页 Slug 不可修改/)).toBeVisible();
});

test('the external-entry dialog inserts a link row directly (no draft)', async ({ page }) => {
	await page.goto('/admin/pages');
	await expect(async () => {
		await page.getByRole('button', { name: '新建' }).click();
		await expect(page.getByRole('menuitem', { name: '外链' })).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 30_000 });
	await page.getByRole('menuitem', { name: '外链' }).click();

	const dialog = page.getByRole('dialog', { name: '新增外链条目' });
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await dialog.locator('input[name="title_en"]').fill('E2E Admin Link');
	await dialog.locator('input[name="slug"]').fill('e2e-admin-link');
	await dialog.locator('input[name="externalUrl"]').fill('https://example.com/e2e');
	await dialog.getByRole('button', { name: '保存' }).click();

	const linkRow = page.getByRole('row').filter({ hasText: 'E2E Admin Link' });
	await expect(linkRow).toBeVisible({ timeout: 20_000 });
	await expect(linkRow.getByText('外链')).toBeVisible();
	expect(psql(`select external_url from pages where slug = 'e2e-admin-link'`)).toBe(
		'https://example.com/e2e'
	);
	// No draft was involved: the inserted row IS the artifact.
	expect(
		psql(
			`select count(*) from drafts where ref_id = (select id from pages where slug = 'e2e-admin-link')`
		)
	).toBe('0');
});

test('creating an md page end-to-end: dual locale, save, publish, render', async ({ page }) => {
	await page.goto('/admin/pages');
	await expect(async () => {
		await page.getByRole('button', { name: '新建' }).click();
		await expect(page.getByRole('menuitem', { name: 'md 页面' })).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 30_000 });
	await page.getByRole('menuitem', { name: 'md 页面' }).click();
	await page.waitForURL(/\/admin\/pages\/edit$/, { timeout: 15_000 });

	// A brand-new page starts on the default language (en).
	const titleInput = page.locator('input[aria-label="标题"]');
	await expect(async () => {
		await titleInput.click();
		await page.keyboard.press('Control+A');
		await page.keyboard.type(NEW_TITLE_EN);
		await expect(titleInput).toHaveValue(NEW_TITLE_EN, { timeout: 2000 });
	}).toPass({ timeout: 30_000 });
	await typeIntoPageEditor(page, 'e2e-new-body-marker en body');

	// Locale switch contract (W1 Q3): flush the en working copy, remount on
	// the empty zh body, then fill the zh title + body - the mount signal is
	// the title input swapping from the en value to ''.
	await expect(async () => {
		await page.getByRole('button', { name: '简体中文' }).click();
		await expect(titleInput).toHaveValue('', { timeout: 3000 });
	}).toPass({ timeout: 30_000 });
	await expect(async () => {
		await titleInput.click();
		await page.keyboard.press('Control+A');
		await page.keyboard.type(NEW_TITLE_ZH);
		await expect(titleInput).toHaveValue(NEW_TITLE_ZH, { timeout: 2000 });
	}).toPass({ timeout: 30_000 });
	await typeIntoPageEditor(page, '管理页正文标记 zh body');

	await setSlug(page, NEW_SLUG);
	await manualSave(page);

	// The first save materialized the placeholder row and anchored the URL;
	// the draft carries BOTH locales (save = merge per language).
	await expect.poll(() => page.url()).toContain('id=');
	const pageId = psql(`select ref_id from drafts where ref_type = 'page' and slug = '${NEW_SLUG}'`);
	expect(pageId).not.toBe('');
	expect(psql(`select slug from pages where id = '${pageId}'`)).toMatch(/^draft-/);
	expect(psql(`select payload->'title'->>'en' from drafts where ref_id = '${pageId}'`)).toBe(
		NEW_TITLE_EN
	);
	expect(psql(`select payload->'title'->>'zh-cn' from drafts where ref_id = '${pageId}'`)).toBe(
		NEW_TITLE_ZH
	);

	await expect(async () => {
		// Idempotent retry (P5-5 T7): treat an already-published row as done.
		if (psql(`select slug from pages where id = '${pageId}'`) === NEW_SLUG) return;
		await page.getByRole('button', { name: '发布' }).click();
		await page.waitForURL(/published=1/, { timeout: 20_000 });
	}).toPass({ timeout: 60_000 });

	// First publish flips the placeholder visible and lands the slug.
	expect(psql(`select slug from pages where id = '${pageId}'`)).toBe(NEW_SLUG);
	expect(psql(`select status from pages where id = '${pageId}'`)).toBe('visible');
	expect(psql(`select title->>'zh-cn' from pages where id = '${pageId}'`)).toBe(NEW_TITLE_ZH);
	expect(psql(`select content->>'en' from pages where id = '${pageId}'`)).toContain(
		'e2e-new-body-marker'
	);
	expect(psql(`select content->>'zh-cn' from pages where id = '${pageId}'`)).toContain(
		'管理页正文标记'
	);
	expect(psql(`select count(*) from drafts where ref_id = '${pageId}'`)).toBe('0');
	// Stale-debounce guard (four-review #1/#6): a debounce armed before the
	// publish could land an attach inside its 2.5s window; wait it out before
	// asserting absence - a bounded fixed wait is the honest way to prove
	// this negative (AUTOSAVE_DEBOUNCE_MS = 2500 in the editor).
	await page.waitForTimeout(2_800);
	expect(psql(`select count(*) from drafts where ref_id = '${pageId}'`)).toBe('0');

	// The published row renders at its zh-cn and bare (en) URLs.
	const freshZh = await page.goto(`/zh-cn/${NEW_SLUG}`);
	expect(freshZh?.status()).toBe(200);
	await expect(page.getByRole('heading', { name: NEW_TITLE_ZH }).first()).toBeVisible();
	const freshEn = await page.goto(`/${NEW_SLUG}`);
	expect(freshEn?.status()).toBe(200);
	await expect(
		page.getByRole('heading', { name: /E2E Admin New|E2E 管理页新页/ }).first()
	).toBeVisible();
});

test('a never-published placeholder reopens in the draft editor (B1)', async ({ page }) => {
	await page.goto('/admin/pages');
	await expect(async () => {
		await page.getByRole('button', { name: '新建' }).click();
		await expect(page.getByRole('menuitem', { name: 'md 页面' })).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 30_000 });
	await page.getByRole('menuitem', { name: 'md 页面' }).click();

	const titleInput = page.locator('input[aria-label="标题"]');
	await expect(async () => {
		await titleInput.click();
		await page.keyboard.press('Control+A');
		await page.keyboard.type('E2E Admin Reload');
		await expect(titleInput).toHaveValue('E2E Admin Reload', { timeout: 2000 });
	}).toPass({ timeout: 30_000 });
	await typeIntoPageEditor(page, 'e2e-reload-marker body');
	await manualSave(page);

	// Reload the anchored URL: a placeholder row (content null, draft- slug)
	// must reopen in the EDITOR, never the retired metadata form (B1 fix).
	await expect.poll(() => page.url()).toContain('id=');
	await page.reload();
	await expect(page.getByRole('textbox', { name: /写下你的页面/ })).toBeVisible({
		timeout: 20_000
	});
	await expect(titleInput).toHaveValue('E2E Admin Reload', { timeout: 15_000 });
	await expect(page.getByRole('button', { name: '发布' })).toBeVisible();
	// The P2 metadata form must not render for this row: its (unreached)
	// title field is the structural probe (三审 F3) - copy-free, unlike the
	// "保存" button that stays hidden only behind the closed Sheet.
	await expect(page.locator('input[name="title_en"]')).toHaveCount(0);

	const pageId = psql(
		`select ref_id from drafts where ref_type = 'page' and payload::text like '%E2E Admin Reload%'`
	);
	expect(pageId).not.toBe('');
	expect(psql(`select slug from pages where id = '${pageId}'`)).toMatch(/^draft-/);
});

test('deleting a fixture row works through the confirmation', async ({ page }) => {
	await page.goto('/admin/pages');
	const rowB = row(page, TITLE_B);
	await expect(rowB).toBeVisible();

	// Give row B a pending draft so the cascade assertion below has teeth
	// (R2-7: without a draft the same assertion passes vacuously).
	psql(
		`insert into drafts (ref_type, ref_id, payload, version) values ('page', '${idB}', '{"title":{"en":"E2E Admin B draft"}}'::jsonb, 1)`
	);
	expect(psql(`select count(*) from drafts where ref_id = '${idB}'`)).toBe('1');

	await expect(async () => {
		if ((await page.getByText('删除页面？').count()) === 0) {
			await rowB.getByRole('button', { name: '删除' }).click();
		}
		await expect(page.getByText('删除页面？')).toBeVisible({ timeout: 5000 });
	}).toPass({ timeout: 30_000 });

	await page.locator('form[action="?/delete"] button[type="submit"]').click();

	await expect(page.getByRole('row').filter({ hasText: TITLE_B })).toHaveCount(0, {
		timeout: 15_000
	});
	expect(psql(`select count(*) from pages where slug = '${SLUG_B}'`)).toBe('0');
	// The cascade leaves no dangling draft rows for the deleted page (M1).
	expect(psql(`select count(*) from drafts where ref_id = '${idB}'`)).toBe('0');
});

test('a malformed id answers 404 instead of crashing', async ({ page }) => {
	const response = await page.goto('/admin/pages/edit?id=not-a-uuid');
	expect(response?.status()).toBe(404);
	await expect(page.getByText('页面不存在')).toBeVisible();
});

test('T11 · an unknown slug answers 404', async ({ page }) => {
	const response = await page.goto('/zh-cn/e2e-admin-no-such-page');
	expect(response?.status()).toBe(404);
});

test('T11 · an external entry 404s at its own slug (menu link only)', async ({ page }) => {
	const response = await page.goto('/zh-cn/e2e-admin-link');
	expect(response?.status()).toBe(404);
});

test('T11 · a page row colliding with a code route never shadows it', async ({ page }) => {
	// The row is injected through raw SQL on purpose: the reserved list keeps
	// `photos` out of reach for every editor path, and the read-side order
	// (file routes above the dynamic [slug]) is exactly what this pins.
	// Premise guard (P5-5 T7): never blow away a row that already exists.
	expect(psql(`select count(*) from pages where slug = 'photos'`)).toBe('0');
	psql(
		`insert into pages (slug, title, content, content_format) values ('photos', '{"en":"E2E Admin Collide"}'::jsonb, '{"en":"collision body"}'::jsonb, 'markdown')`
	);
	try {
		const response = await page.goto('/zh-cn/photos');
		expect(response?.status()).toBe(200);
		await expect(page.getByText('collision body')).toHaveCount(0);
	} finally {
		psql(`delete from pages where slug = 'photos'`);
	}
});
