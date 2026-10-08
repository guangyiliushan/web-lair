import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * Projects P acceptance (plan §7 T14): the public grid renders only
 * `published` rows; the card trio (provider badge, direct link rel/target,
 * secondary exits), the empty state, the unpublished negative set and the
 * unsafe-URL rendering rule. Fixtures share the `e2e-p` marker prefix
 * (owned by this spec) and are cleaned around the run. The empty-state case
 * additionally requires a live DB without other published rows (it skips
 * itself otherwise - batch A rows will legitimately appear later); the
 * deterministic empty-copy coverage lives in projects-grid.svelte.spec.ts.
 */

const FIX = 'e2e-p';
const REPO_NAME = `${FIX} 仓库夹具`;
const SITE_NAME = `${FIX} 网站夹具`;
const OTHER_NAME = `${FIX} 第三方夹具`;
const UNSAFE_NAME = `${FIX} 不安全夹具`;
const PENDING_NAME = `${FIX} 待复核夹具`;
const HIDDEN_NAME = `${FIX} 下架夹具`;
const REJECTED_NAME = `${FIX} 拒绝夹具`;

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

	test('renders published cards with the card trio and hides unpublished rows', async ({
		page
	}) => {
		cleanup();
		psql(
			`insert into projects (name, description, provider, external_id, project_url, preview_url, language, stars, pushed_at, status, sort_order) values ('${REPO_NAME}', '夹具描述', 'github', 'e2e-p-1', 'https://github.com/e2e-fixture/repo', 'https://preview.example/', 'TypeScript', 42, now() - interval '3 days', 'published', 1)`
		);
		psql(
			`insert into projects (name, description, provider, project_url, doc_url, status, sort_order) values ('${SITE_NAME}', null, 'site', 'https://fixture.example/', 'https://docs.example/', 'published', 2)`
		);
		psql(
			`insert into projects (name, description, provider, project_url, status, sort_order) values ('${OTHER_NAME}', null, 'other', 'https://other.example/', 'published', 3)`
		);
		psql(
			`insert into projects (name, provider, project_url, status, sort_order) values ('${UNSAFE_NAME}', 'other', 'javascript:alert(1)', 'published', 4)`
		);
		psql(
			`insert into projects (name, provider, project_url, status, sort_order) values ('${PENDING_NAME}', 'other', 'https://pending.example/', 'pending', 5)`
		);
		psql(
			`insert into projects (name, provider, project_url, status, sort_order) values ('${HIDDEN_NAME}', 'other', 'https://hidden.example/', 'hidden', 6)`
		);
		psql(
			`insert into projects (name, provider, project_url, status, sort_order) values ('${REJECTED_NAME}', 'other', 'https://rejected.example/', 'rejected', 7)`
		);

		await page.goto('/zh-cn/projects');
		await expect(page.getByRole('heading', { name: '项目' })).toBeVisible({ timeout: 20_000 });

		// Repo card: brand badge, direct link target/rel, status row (incl.
		// the pushed-at label), preview exit only (no doc_url on the fixture).
		const repoCard = page.locator('article', { hasText: REPO_NAME });
		await expect(repoCard).toBeVisible({ timeout: 20_000 });
		await expect(repoCard.getByText('GitHub', { exact: true })).toBeVisible();
		await expect(repoCard.getByText('TypeScript', { exact: true })).toBeVisible();
		await expect(repoCard.getByText('42', { exact: true })).toBeVisible();
		await expect(repoCard.getByText(/\d{4}年\d{1,2}月\d{1,2}日/)).toBeVisible();
		const repoLink = repoCard.getByRole('link', { name: `访问仓库: ${REPO_NAME}` });
		await expect(repoLink).toHaveAttribute('href', 'https://github.com/e2e-fixture/repo');
		await expect(repoLink).toHaveAttribute('target', '_blank');
		await expect(repoLink).toHaveAttribute('rel', /noopener noreferrer/);
		const previewLink = repoCard.getByRole('link', { name: `预览: ${REPO_NAME}` });
		await expect(previewLink).toHaveAttribute('href', 'https://preview.example/');
		await expect(previewLink).toHaveAttribute('target', '_blank');
		await expect(previewLink).toHaveAttribute('rel', /noopener noreferrer/);
		await expect(repoCard.getByRole('link', { name: `文档: ${REPO_NAME}` })).toHaveCount(0);

		// Site card: site badge, direct link rel/target, docs exit rel/target.
		const siteCard = page.locator('article', { hasText: SITE_NAME });
		await expect(siteCard).toBeVisible();
		await expect(siteCard.getByText('网站', { exact: true })).toBeVisible();
		const siteLink = siteCard.getByRole('link', { name: `访问网站: ${SITE_NAME}` });
		await expect(siteLink).toHaveAttribute('href', 'https://fixture.example/');
		await expect(siteLink).toHaveAttribute('target', '_blank');
		await expect(siteLink).toHaveAttribute('rel', /noopener noreferrer/);
		const docsLink = siteCard.getByRole('link', { name: `文档: ${SITE_NAME}` });
		await expect(docsLink).toBeVisible();
		await expect(docsLink).toHaveAttribute('target', '_blank');
		await expect(docsLink).toHaveAttribute('rel', /noopener noreferrer/);
		await expect(siteCard.getByRole('link', { name: `预览: ${SITE_NAME}` })).toHaveCount(0);
		// The icon slot always settles on the fallback glyph: the proxy
		// denies fixture.example (not in the embed-registry whitelist), and
		// the completion check covers failures that predate hydration.
		await expect(siteCard.locator('.project-card-fallback')).toBeVisible({ timeout: 10_000 });

		// Other card: other badge, visit-site label, no exits.
		const otherCard = page.locator('article', { hasText: OTHER_NAME });
		await expect(otherCard.getByText('其他', { exact: true })).toBeVisible();
		await expect(otherCard.getByRole('link', { name: `访问网站: ${OTHER_NAME}` })).toHaveAttribute(
			'href',
			'https://other.example/'
		);
		await expect(otherCard.locator('a')).toHaveCount(1);

		// Unsafe (non-http scheme) rows render the name without any link.
		const unsafeCard = page.locator('article', { hasText: UNSAFE_NAME });
		await expect(unsafeCard).toBeVisible();
		await expect(unsafeCard.locator('a')).toHaveCount(0);
		await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);

		// Unpublished rows (pending / hidden / rejected) never render.
		for (const name of [PENDING_NAME, HIDDEN_NAME, REJECTED_NAME]) {
			await expect(page.getByText(name)).toHaveCount(0);
		}

		// Ordering: sort_order 1 (repo) before sort_order 2 (site).
		const order = await page
			.locator('article')
			.evaluateAll(
				(elements, [repo, site]) =>
					[
						elements.findIndex((el) => el.textContent?.includes(repo as string)),
						elements.findIndex((el) => el.textContent?.includes(site as string))
					] as [number, number],
				[REPO_NAME, SITE_NAME]
			);
		expect(order[0]).toBeGreaterThanOrEqual(0);
		expect(order[1]).toBeGreaterThan(order[0]);

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
