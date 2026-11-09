import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { psql } from './support';
import { zhCnLocale } from './locale-fixture';

test.use(zhCnLocale);

const SLUG = 'e2e-summary-source';
const TITLE = 'E2E summary source';
const CONTENT = '# Body\n\nA long enough public body for the summary adoption flow.';
const CANDIDATE = 'E2E candidate summary: a short public body.';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(() => {
	cleanup();
	const category = psql(`select id from categories limit 1`);
	const hash = createHash('sha256')
		.update(JSON.stringify([TITLE, CONTENT]))
		.digest('hex');
	psql(`insert into posts (title, slug, lang, category_id, status, content, content_format, published_at)
		values ('${TITLE}', '${SLUG}', 'en', '${category}', 'published', '${CONTENT}', 'markdown', now())`);
	const postId = psql(`select id from posts where slug = '${SLUG}'`);
	psql(`insert into summaries (post_id, lang, source_hash, summary, model)
		values ('${postId}', 'en', '${hash}', '${CANDIDATE}', 'e2e-model')`);
});

test.afterAll(() => {
	cleanup();
});

function cleanup() {
	psql(`delete from summaries where summary = '${CANDIDATE}'`);
	psql(`delete from posts where slug = '${SLUG}'`);
}

/**
 * The metadata bar (summary + candidates) starts collapsed, so every test that
 * reads it has to open it first. Hydration-tolerant: an early click lands on
 * inert SSR markup.
 */
async function expandMetaBar(page: Page) {
	await expect(async () => {
		if (!(await page.locator('#post-summary').isVisible())) {
			await page.getByRole('button', { name: '展开文章设置' }).click({ timeout: 2000 });
		}
		await expect(page.locator('#post-summary')).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30000 });
}

test('adopts a summary candidate into posts.summary', async ({ page, request }) => {
	const postId = psql(`select id from posts where slug = '${SLUG}'`);
	await page.goto(`/admin/posts/edit?id=${postId}`);
	await expandMetaBar(page);
	await expect(page.getByText(CANDIDATE)).toBeVisible({ timeout: 15000 });

	await expect(async () => {
		if (!(await page.getByText('摘要已采纳').isVisible())) {
			await page.getByRole('button', { name: '采纳' }).first().click({ timeout: 5000 });
		}
		await expect(page.getByText('摘要已采纳')).toBeVisible({ timeout: 8000 });
	}).toPass({ timeout: 60_000 });

	expect(psql(`select summary from posts where id = '${postId}'`)).toBe(CANDIDATE);
	expect(
		psql(`select count(*) from summaries where post_id = '${postId}' and adopted_at is not null`)
	).toBe('1');
	const publicPage = await request.get('/en/posts/e2e-summary-source');
	expect(publicPage.status()).toBe(200);
	const html = await publicPage.text();
	expect(html).toContain(CANDIDATE);
	expect(html).toContain('AI summary');
});

/**
 * What an AI control says about itself.
 *
 * The readiness-first rule governs the summary button: a disabled one must
 * explain the blocker, never the consequence of running it ("将覆盖当前简介"),
 * and only an enabled one describes what it would do.
 *
 * Asserted as an invariant rather than against a fixed configuration, because
 * these specs share one database and other files mutate `ai.assignments`.
 */
test('the summary control explains itself whichever way readiness lands', async ({ page }) => {
	const postId = psql(`select id from posts where slug = '${SLUG}'`);
	await page.goto(`/admin/posts/edit?id=${postId}`);
	await expandMetaBar(page);

	const generate = page.getByRole('button', { name: '生成摘要' });
	await expect(generate).toBeVisible({ timeout: 15000 });
	const generateTitle = await generate.getAttribute('title');
	expect(generateTitle).toBeTruthy();
	if (await generate.isDisabled()) {
		expect(generateTitle).not.toContain('将覆盖当前简介');
	} else {
		expect(generateTitle).toBe('将覆盖当前简介');
	}

	// The language bar carries the versions themselves only: the "AI 翻译"
	// trigger and the "AI 记录" ledger link were noise next to them.
	await expect(page.getByRole('button', { name: 'AI 翻译' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'AI 记录' })).toHaveCount(0);
});
