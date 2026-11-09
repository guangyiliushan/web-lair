import { expect, test } from '@playwright/test';
import { psql } from './support';
import { zhCnLocale } from './locale-fixture';

test.use(zhCnLocale);

/**
 * Translation workbench accept (M2 2a): a generated candidate is accepted into
 * the target working copy, but is NOT published. The accept transaction is the
 * assertion target: target post + draft + translation_origin + accepted row.
 */
const SOURCE_SLUG = 'e2e-ai-translation-source';
const TITLE = 'E2E AI translation candidate';
const DISCARDED_TITLE = 'E2E discarded candidate';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(() => {
	cleanup();
	const category = psql(`select id from categories limit 1`);
	expect(category).not.toBe('');
	psql(`insert into posts (title, slug, lang, category_id, status, content, content_format, published_at)
		values ('E2E AI source', '${SOURCE_SLUG}', 'en', '${category}', 'published', 'Hello world. This is a source body.', 'markdown', now())`);
	const sourceId = psql(`select id from posts where slug = '${SOURCE_SLUG}'`);
	psql(`insert into translations (source_post_id, target_lang, title, content, content_format, origin, source_hash, status)
		values ('${sourceId}', 'zh-cn', '${TITLE}', '# 你好\n\n这是译文正文。', 'markdown', 'ai', null, 'draft')`);
});

test.afterAll(() => {
	cleanup();
});

function cleanup() {
	psql(`delete from translations where title in ('${TITLE}', '${DISCARDED_TITLE}')`);
	psql(`delete from posts where slug = '${SOURCE_SLUG}'`);
}

/**
 * The workbench is a first-class ops surface: it lives in the sidebar, and the
 * page itself is the shared list surface (the shell header owns the title, so
 * the body carries no second copy of it).
 */
test('lives in the sidebar and renders the shared list surface', async ({ page }) => {
	await page.goto('/admin/translations');
	await expect(page.getByRole('table', { name: '翻译任务' })).toBeVisible();

	const sidebar = page.locator('[data-sidebar="sidebar"]').first();
	// Sanity: the locator really is the nav, so the link assertion is not vacuous.
	await expect(sidebar.locator('a[href="/admin/posts"]')).toHaveCount(1);
	await expect(sidebar.locator('a[href="/admin/translations"]')).toHaveCount(1);
});

test('previews the candidate beside its source without leaving the list', async ({ page }) => {
	await page.goto('/admin/translations?status=draft');
	const row = page.getByRole('row').filter({ hasText: TITLE }).first();
	await expect(row).toBeVisible();
	await row.getByRole('link', { name: `预览: ${TITLE}` }).click();

	await expect(page).toHaveURL(/[?&]preview=/);
	const sheet = page.getByRole('dialog');
	await expect(sheet).toBeVisible();
	// Both bodies render: the source body the model read, and the candidate.
	const preview = sheet.getByTestId('translation-workbench-preview');
	await expect(preview).toContainText('Hello world. This is a source body.');
	await expect(preview).toContainText('这是译文正文');

	await sheet.getByRole('button', { name: '关闭' }).click();
	await expect(page).not.toHaveURL(/[?&]preview=/);
	await expect(sheet).not.toBeVisible();
});

test('collapses columns into the title cell without losing or duplicating a fact', async ({
	page
}) => {
	await page.goto('/admin/translations?status=all');
	const row = page.getByRole('row').filter({ hasText: TITLE }).first();
	await expect(row).toBeVisible();

	const column = {
		lang: page.getByRole('columnheader', { name: '语言' }),
		status: page.getByRole('columnheader', { name: '状态' }),
		source: page.getByRole('columnheader', { name: '来源' })
	};
	const inline = {
		lang: row.locator('[data-inline="lang"]'),
		status: row.locator('[data-inline="status"]'),
		source: row.locator('[data-inline="source"]')
	};

	// One representation per fact at every width: the inline copy exists exactly
	// where its column is dropped (sm = language, md = status, lg = source).
	const cases = [
		{ width: 1400, lang: 'column', status: 'column', source: 'column' },
		{ width: 860, lang: 'column', status: 'column', source: 'inline' },
		{ width: 700, lang: 'column', status: 'inline', source: 'inline' },
		{ width: 500, lang: 'inline', status: 'inline', source: 'inline' }
	] as const;

	for (const entry of cases) {
		await page.setViewportSize({ width: entry.width, height: 900 });
		for (const key of ['lang', 'status', 'source'] as const) {
			if (entry[key] === 'inline') {
				await expect(column[key]).toBeHidden();
				await expect(inline[key]).toBeVisible();
			} else {
				await expect(column[key]).toBeVisible({ timeout: 5000 });
				await expect(inline[key]).toBeHidden();
			}
		}
	}
	// Later tests click row actions; give them the default width back.
	await page.setViewportSize({ width: 1280, height: 900 });
});

test('accepts a candidate into the target draft without publishing', async ({ page }) => {
	await page.goto('/admin/translations?status=draft');
	await expect(page.getByRole('table', { name: '翻译任务' })).toBeVisible();
	const row = page.getByRole('row').filter({ hasText: TITLE }).first();
	await expect(row).toBeVisible();
	await row.getByRole('button', { name: '采纳' }).click();

	await expect(page).toHaveURL(/\/admin\/posts\/edit\?id=/, { timeout: 20_000 });
	const targetId = psql(
		`select id from posts where translated_from_post_id = (select id from posts where slug = '${SOURCE_SLUG}' and lang = 'en') and lang = 'zh-cn'`
	);
	expect(targetId).not.toBe('');
	expect(psql(`select status from translations where title = '${TITLE}'`)).toBe('accepted');
	expect(psql(`select translation_origin from posts where id = '${targetId}'`)).toBe('ai');
	expect(
		psql(`select count(*) from drafts where ref_type = 'post' and ref_id = '${targetId}'`)
	).toBe('1');
	expect(
		psql(`select content from drafts where ref_type = 'post' and ref_id = '${targetId}'`)
	).toContain('这是译文正文');
	// Acceptance must not publish the target.
	expect(psql(`select status from posts where id = '${targetId}'`)).toBe('draft');
});

/**
 * The language bar is a fixed ruler, not a live readout: the source chip keeps
 * its role marker on every version's page. Showing only the status away from
 * the source made the same chip change width the moment another language was
 * opened, shifting the rest of the bar.
 */
test('language chips read the same on every version of the family', async ({ page }) => {
	const sourceId = psql(`select id from posts where slug = '${SOURCE_SLUG}' and lang = 'en'`);
	const targetId = psql(
		`select id from posts where translated_from_post_id = '${sourceId}' and lang = 'zh-cn'`
	);
	expect(targetId).not.toBe('');

	for (const id of [sourceId, targetId]) {
		await page.goto(`/admin/posts/edit?id=${id}`);
		await expect(page.getByRole('button', { name: 'en·源·已发布', exact: true })).toBeVisible({
			timeout: 15_000
		});
		await expect(page.getByRole('button', { name: 'zh-cn·草稿', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'ja·未译', exact: true })).toBeVisible();
	}
});

test('permanently deletes a discarded record', async ({ page }) => {
	const sourceId = psql(`select id from posts where slug = '${SOURCE_SLUG}' and lang = 'en'`);
	expect(sourceId).not.toBe('');
	psql(`insert into translations (source_post_id, target_lang, title, content, content_format, origin, source_hash, status)
		values ('${sourceId}', 'ja', '${DISCARDED_TITLE}', '# 破棄', 'markdown', 'ai', null, 'discarded')`);

	await page.goto('/admin/translations?status=discarded');
	const row = page.getByRole('row').filter({ hasText: DISCARDED_TITLE }).first();
	await expect(row).toBeVisible();

	// Discarded is the only status whose slot is the permanent delete, and the
	// first click only arms the confirm.
	await row.getByRole('button', { name: `彻底删除: ${DISCARDED_TITLE}` }).click();
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: '彻底删除', exact: true }).click();

	await expect(row).toHaveCount(0);
	await expect(page.getByRole('status')).toHaveText('记录已删除');
	// Gone from the table, not merely filtered out of the current view.
	expect(psql(`select count(*) from translations where title = '${DISCARDED_TITLE}'`)).toBe('0');
});

test('refuses to resync once the target is published (P0-1)', async ({ page }) => {
	const targetId = psql(
		`select id from posts where translated_from_post_id = (select id from posts where slug = '${SOURCE_SLUG}' and lang = 'en') and lang = 'zh-cn'`
	);
	expect(targetId).not.toBe('');
	// Simulate the publish; the publish guard itself is covered elsewhere.
	psql(`update posts set status = 'published' where id = '${targetId}'`);
	try {
		await page.goto('/admin/translations?status=accepted');
		const row = page.getByRole('row').filter({ hasText: TITLE }).first();
		await expect(row).toBeVisible();
		await row.getByRole('button', { name: '回源重译' }).click();
		// zh-cn is pinned by test.use(zhCnLocale) above, so the flash is the
		// zh-cn catalog string, not its English counterpart.
		await expect(page.getByRole('status')).toHaveText('译文已发布，无法重新同步');
		// The row must stay accepted - the pre-fix behavior flipped it to
		// draft and deadlocked both accept and publish.
		expect(psql(`select status from translations where title = '${TITLE}'`)).toBe('accepted');
	} finally {
		psql(`update posts set status = 'draft' where id = '${targetId}'`);
	}
});
