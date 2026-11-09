import { expect, test } from '@playwright/test';
import { psql } from './support';
import { zhCnLocale } from './locale-fixture';

test.use(zhCnLocale);

/**
 * B9: the drawer's whole promise on one page. A candidate is seeded straight
 * into the database (generation needs a configured provider the test database
 * does not guarantee), then previewed beside its source, accepted into a
 * draft, and opened - every step from the editor, never the workbench.
 */
const SOURCE_SLUG = 'e2e-drawer-translation-source';
const SOURCE_TITLE = 'E2E drawer source';
const CANDIDATE_TITLE = 'E2E drawer candidate';
const CANDIDATE_BODY = '# 候補の本文';
const SHOT = '.superpowers/sdd/2026-11-04-translation-drawer/drawer-candidate.png';

let sourceId = '';
let targetId = '';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(() => {
	cleanup();
	const category = psql(`select id from categories limit 1`);
	expect(category).not.toBe('');
	psql(`insert into posts (title, slug, lang, category_id, status, content, content_format, published_at)
		values ('${SOURCE_TITLE}', '${SOURCE_SLUG}', 'en', '${category}', 'published', 'Hello world. This is a source body.', 'markdown', now())`);
	sourceId = psql(`select id from posts where slug = '${SOURCE_SLUG}' and lang = 'en'`);
	expect(sourceId).not.toBe('');
	// `source_hash` stays null so accept skips the staleness check.
	const candidateId =
		psql(`insert into translations (source_post_id, target_lang, title, content, content_format, origin, status, error, source_hash, updated_at)
		values ('${sourceId}', 'ja', '${CANDIDATE_TITLE}', '${CANDIDATE_BODY}', 'markdown', 'ai', 'draft', null, null, now())
		returning id`);
	expect(candidateId).not.toBe('');
});

test.afterAll(() => {
	cleanup();
});

function cleanup() {
	const targets = `select id from posts where translated_from_post_id in (select id from posts where slug = '${SOURCE_SLUG}')`;
	if (targetId) psql(`delete from drafts where ref_type = 'post' and ref_id = '${targetId}'`);
	psql(`delete from drafts where ref_type = 'post' and ref_id in (${targets})`);
	psql(
		`delete from posts where translated_from_post_id in (select id from posts where slug = '${SOURCE_SLUG}')`
	);
	psql(
		`delete from translations where source_post_id in (select id from posts where slug = '${SOURCE_SLUG}')`
	);
	psql(`delete from posts where slug = '${SOURCE_SLUG}'`);
}

test('previews, accepts, and opens the ja target from the editor', async ({ page }) => {
	await page.goto(`/admin/posts/edit?id=${sourceId}`);

	const chip = page.getByRole('button', { name: 'ja·未译', exact: true });
	await expect(chip).toBeVisible({ timeout: 20_000 });

	const dialog = page.getByRole('dialog');
	// The SSR chip is clickable before SvelteKit hydrates; retry the click-pair.
	// A landed click leaves the sheet open, so an attempt that finds it open is
	// already done - clicking again would hit the overlay instead of the chip.
	await expect(async () => {
		if (await dialog.isVisible()) return;
		await chip.click({ timeout: 2000 });
		await expect(dialog).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30_000 });

	await expect(dialog.getByRole('heading', { name: /^ja · / })).toContainText('待确认');

	const preview = dialog.getByTestId('translation-preview');
	await expect(preview).toBeVisible();
	// Captions name the side only; the article titles live in the header/editor
	// and must not be repeated into the 300px columns.
	await expect(preview.getByText('源文', { exact: true })).toBeVisible();
	await expect(preview.getByText('候选', { exact: true })).toBeVisible();
	await expect(preview).not.toContainText(SOURCE_TITLE);
	await expect(preview).not.toContainText(CANDIDATE_TITLE);
	await expect(preview.getByRole('heading', { name: '候補の本文' })).toBeVisible();

	// The design-review artifact: let the sheet's enter animation settle so the
	// capture shows the drawer, not a half-faded overlay over the page.
	await dialog.evaluate(async (el) => {
		await Promise.all(
			el
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished.catch(() => undefined))
		);
	});
	await page.screenshot({ path: SHOT, fullPage: false });

	await dialog.getByRole('button', { name: '接受进草稿' }).click();
	const openTarget = dialog.getByRole('button', { name: '打开目标文章' });
	await expect(openTarget).toBeVisible({ timeout: 30_000 });
	await expect(openTarget).toBeEnabled();

	// Accept creates the row the drawer now offers to open; capture it here so
	// both the navigation and the cleanup use the same id.
	targetId = psql(
		`select id from posts where translated_from_post_id = '${sourceId}' and lang = 'ja'`
	);
	expect(targetId).not.toBe('');
	expect(targetId).not.toBe(sourceId);

	await openTarget.click();
	await expect(page).toHaveURL(new RegExp(`[?&]id=${targetId}`), { timeout: 20_000 });

	// The editor is now on the ja version, so its chip is the current one.
	await expect(page.getByRole('button', { name: 'ja·草稿', exact: true })).toHaveAttribute(
		'aria-current',
		'true',
		{ timeout: 20_000 }
	);
	// The accepted body is the target's draft, not just a new empty row.
	await expect(page.locator('input[name="title"]')).toHaveValue(CANDIDATE_TITLE, {
		timeout: 20_000
	});
	await expect(page.getByRole('textbox', { name: '输入正文...' })).toContainText('候補の本文', {
		timeout: 20_000
	});
});
