import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * Projects P acceptance (plan §7 T14): the public grid renders only
 * `published` rows; the card trio (provider badge, direct link rel/target,
 * secondary exits) and the empty state. Fixtures are marker-prefixed and
 * cleaned around the run; the empty-state case additionally requires a live
 * DB without other published rows (it skips itself otherwise - batch A rows
 * will legitimately appear later).
 */

const FIX = 'e2e-p';
const REPO_NAME = `${FIX} 仓库夹具`;
const SITE_NAME = `${FIX} 网站夹具`;
const PENDING_NAME = `${FIX} 待复核夹具`;

function cleanup(): void {
	psql(`delete from projects where name like '${FIX}%'`);
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.use(zhCnLocale);

test.beforeAll(() => {
	cleanup();
});

test.afterAll(() => {
	cleanup();
});

test.describe('projects public grid', () => {
	test('shows the empty copy when no row is published', async ({ page }) => {
		const published = psql(`select count(*) from projects where status = 'published'`);
		test.skip(published !== '0', 'live DB has other published rows');
		await page.goto('/zh-cn/projects');
		await expect(page.getByRole('heading', { name: '项目' })).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText('还没有项目。')).toBeVisible();
	});

	test('renders published repo and site cards with the card trio', async ({ page }) => {
		cleanup();
		psql(
			`insert into projects (name, description, provider, external_id, project_url, preview_url, language, stars, pushed_at, status, sort_order) values ('${REPO_NAME}', '夹具描述', 'github', 'e2e-p-1', 'https://github.com/e2e-fixture/repo', 'https://preview.example/', 'TypeScript', 42, now() - interval '3 days', 'published', 1)`
		);
		psql(
			`insert into projects (name, description, provider, project_url, doc_url, status, sort_order) values ('${SITE_NAME}', null, 'site', 'https://fixture.example/', 'https://docs.example/', 'published', 2)`
		);
		psql(
			`insert into projects (name, provider, project_url, status, sort_order) values ('${PENDING_NAME}', 'other', 'https://pending.example/', 'pending', 3)`
		);

		await page.goto('/zh-cn/projects');
		await expect(page.getByRole('heading', { name: '项目' })).toBeVisible({ timeout: 20_000 });

		// Repo card: brand badge, direct link target/rel, status row, preview
		// exit only (no doc_url on the fixture).
		const repoCard = page.locator('article', { hasText: REPO_NAME });
		await expect(repoCard).toBeVisible({ timeout: 20_000 });
		await expect(repoCard.getByText('GitHub')).toBeVisible();
		await expect(repoCard.getByText('TypeScript')).toBeVisible();
		await expect(repoCard.getByText('42')).toBeVisible();
		const repoLink = repoCard.getByRole('link', { name: `访问仓库: ${REPO_NAME}` });
		await expect(repoLink).toHaveAttribute('href', 'https://github.com/e2e-fixture/repo');
		await expect(repoLink).toHaveAttribute('target', '_blank');
		await expect(repoLink).toHaveAttribute('rel', /noopener noreferrer/);
		await expect(repoCard.getByRole('link', { name: `预览: ${REPO_NAME}` })).toHaveAttribute(
			'href',
			'https://preview.example/'
		);
		await expect(repoCard.getByRole('link', { name: `文档: ${REPO_NAME}` })).toHaveCount(0);

		// Site card: site badge, direct link, docs exit only.
		const siteCard = page.locator('article', { hasText: SITE_NAME });
		await expect(siteCard).toBeVisible();
		await expect(siteCard.getByText('网站', { exact: true })).toBeVisible();
		await expect(siteCard.getByRole('link', { name: `访问网站: ${SITE_NAME}` })).toHaveAttribute(
			'href',
			'https://fixture.example/'
		);
		await expect(siteCard.getByRole('link', { name: `文档: ${SITE_NAME}` })).toBeVisible();
		await expect(siteCard.getByRole('link', { name: `预览: ${SITE_NAME}` })).toHaveCount(0);

		// Unpublished rows never render.
		await expect(page.getByText(PENDING_NAME)).toHaveCount(0);

		// The archived badge joins the card once the row is archived.
		psql(`update projects set archived = true where name = '${REPO_NAME}'`);
		await expect(async () => {
			await page.reload();
			await expect(repoCard.getByText('已归档')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 30_000 });
	});

	test('the grid serves every locale', async ({ page }) => {
		await page.goto('/en/projects');
		await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({
			timeout: 20_000
		});
		await page.goto('/ja/projects');
		await expect(page.getByRole('heading', { name: 'プロジェクト' })).toBeVisible({
			timeout: 20_000
		});
	});
});
