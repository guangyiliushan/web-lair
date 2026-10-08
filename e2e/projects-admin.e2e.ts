import { expect, test, type Locator, type Page } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * Projects A acceptance (plan §7 T11-T13): the real admin surface against
 * the real database - create (with the write-side URL normalization pinned),
 * the four-value state machine through the bulk bar, transactional reorder
 * (top/up/down) with the public grid staying in order, the edit dialog
 * (including the duplicate-URL 400), the sync enqueue (zero-target guard,
 * flash, queued row, dedup, recent-run card), sync-target persistence and
 * case-insensitive duplicate refusal, the import error paths, the bulk
 * delete cancel + confirm paths and the skipped-count flash.
 * Fixtures share the `e2e-adminproj-` marker (deliberately outside the
 * public spec's `e2e-p%` cleanup net). The spec snapshots the live
 * `projects.sync_targets` option and restores it afterwards (review P1: a
 * bare delete would wipe a real configuration).
 */

const FIX = 'e2e-adminproj-';
const ROW_A = `${FIX}alpha`;
const ROW_B = `${FIX}beta`;
const ROW_C = `${FIX}gamma`;

/** Raw jsonb text of the live sync-targets option ('' = no row). */
let savedTargets: string | null = null;
const TARGETS_OPTION = 'projects.sync_targets';

function snapshotTargets(): void {
	const value = psql(`select value::text from options where name = '${TARGETS_OPTION}'`);
	savedTargets = value === '' ? null : value;
}

function restoreTargets(): void {
	if (savedTargets === null) {
		psql(`delete from options where name = '${TARGETS_OPTION}'`);
	} else {
		const escaped = savedTargets.replaceAll("'", "''");
		psql(
			`insert into options (name, value) values ('${TARGETS_OPTION}', '${escaped}'::jsonb) on conflict (name) do update set value = excluded.value`
		);
	}
}

function cleanup(): void {
	psql(`delete from projects where name like '${FIX}%'`);
	// Queued runs are the spec's own leftovers; pre-existing test runs assume
	// no drain is executing project syncs concurrently (documented).
	psql(`delete from job_runs where job = 'projects.sync' and status = 'queued'`);
	psql(`delete from options where name = '${TARGETS_OPTION}'`);
}

function statusOf(name: string): string {
	return psql(`select status from projects where name = '${name}'`);
}

function sortOf(name: string): number {
	return Number(psql(`select sort_order from projects where name = '${name}'`));
}

function rowByName(page: Page, name: string): Locator {
	return page.locator('li', { hasText: name });
}

async function toggleRow(page: Page, name: string): Promise<void> {
	const checkbox = page.getByRole('checkbox', { name: `${name} 选择` });
	await expect(async () => {
		await checkbox.check({ timeout: 5000 });
		await expect(checkbox).toBeChecked({ timeout: 2000 });
		await expect(page.getByText(/已选 \d+ 项/)).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 15_000 });
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use(zhCnLocale);

test.beforeAll(() => {
	snapshotTargets();
	cleanup();
});

test.afterAll(() => {
	cleanup();
	restoreTargets();
	// Self-check (closing review): the restore must land exactly on the
	// snapshot value.
	const restored = psql(`select value::text from options where name = '${TARGETS_OPTION}'`);
	expect(restored === '' ? null : restored).toBe(savedTargets);
});

test.describe('projects admin', () => {
	test('creates a row through the dialog (normalized) and deletes it through the confirm', async ({
		page
	}) => {
		await page.goto('/admin/projects');
		await expect(page.getByRole('heading', { name: '项目' })).toBeVisible({ timeout: 20_000 });

		await expect(async () => {
			await page.getByRole('button', { name: '新建项目' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('名称').fill(ROW_C);
		await dialog.getByLabel('主链接').fill('https://Gamma.example/');
		await dialog.getByRole('button', { name: '创建' }).click({ timeout: 5000 });
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText('项目已创建。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_C)).toBe('published');
		// Write-side normalization (§2.8-4): host lowercased, trailing slash
		// dropped - the variant form below must therefore collide.
		expect(psql(`select project_url from projects where name = '${ROW_C}'`)).toBe(
			'https://gamma.example'
		);

		// The normalized duplicate is refused through the unique index.
		await expect(async () => {
			await page.getByRole('button', { name: '新建项目' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		await dialog.getByLabel('名称').fill(`${ROW_C}-dup`);
		await dialog.getByLabel('主链接').fill('https://gamma.example');
		await dialog.getByRole('button', { name: '创建' }).click({ timeout: 5000 });
		await expect(dialog.getByText('已存在相同链接或仓库')).toBeVisible({ timeout: 20_000 });
		await page.keyboard.press('Escape');

		// Single delete through the row trash + confirm dialog.
		const row = rowByName(page, ROW_C);
		await expect(row).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			await row.getByRole('button', { name: '删除', exact: true }).click({ timeout: 5000 });
			await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 15_000 });
		const confirm = page.getByRole('alertdialog');
		await confirm.getByRole('button', { name: '删除' }).click({ timeout: 5000 });
		await expect(confirm).toBeHidden({ timeout: 20_000 });
		await expect(rowByName(page, ROW_C)).toHaveCount(0, { timeout: 20_000 });
		expect(psql(`select count(*) from projects where name like '${FIX}%'`)).toBe('0');
	});

	test('walks the state machine through the bulk bar', async ({ page }) => {
		psql(
			`insert into projects (name, provider, project_url, status, sort_order) values ('${ROW_A}', 'other', 'https://alpha.example', 'pending', 1)`
		);
		await page.goto('/admin/projects?status=pending');
		const row = rowByName(page, ROW_A);
		await expect(row).toBeVisible({ timeout: 20_000 });

		// Filter negative (review): a pending row must not render under the
		// published tab.
		await page.goto('/admin/projects?status=published');
		await expect(rowByName(page, ROW_A)).toHaveCount(0, { timeout: 20_000 });

		// pending -> published (T11: visible on the public grid).
		await page.goto('/admin/projects?status=pending');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '通过' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('published');
		await page.goto('/zh-cn/projects');
		await expect(page.getByText(ROW_A)).toBeVisible({ timeout: 20_000 });

		// published -> hidden -> published.
		await page.goto('/admin/projects?status=published');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '下架' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('hidden');
		await page.goto('/admin/projects?status=hidden');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '通过' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('published');

		// published -> rejected (permanent memory) -> restored to pending.
		await page.goto('/admin/projects?status=published');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '拒绝' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('rejected');
		await page.goto('/admin/projects?status=rejected');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '恢复为待复核' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('pending');
	});

	test('reorders transactionally (top / down / up) and the public grid follows', async ({
		page
	}) => {
		psql(`update projects set status = 'published', sort_order = 1 where name = '${ROW_A}'`);
		psql(
			`insert into projects (name, provider, project_url, status, sort_order) values ('${ROW_B}', 'other', 'https://beta.example', 'published', 2)`
		);
		await page.goto('/admin/projects?status=published');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });

		// Pin beta to the top; the full list renumbers 1..N. The assertion is
		// relative on purpose - other specs' rows (e.g. projects-public's
		// fixture at sort_order 1) may share the tie band.
		await expect(async () => {
			await rowByName(page, ROW_B).getByRole('button', { name: '置顶' }).click({ timeout: 5000 });
			await expect.poll(() => sortOf(ROW_B) < sortOf(ROW_A), { timeout: 5000 }).toBe(true);
		}).toPass({ timeout: 15_000 });
		await expect(async () => {
			const order = psql(
				`select string_agg(name, ',' order by sort_order) from projects where name like '${FIX}%'`
			);
			expect(order).toBe(`${ROW_B},${ROW_A}`);
		}).toPass({ timeout: 20_000 });

		// Down on the first row swaps it back after alpha (down branch).
		await rowByName(page, ROW_B).getByRole('button', { name: '下移' }).click({ timeout: 5000 });
		await expect(async () => {
			expect(sortOf(ROW_B)).toBeGreaterThan(sortOf(ROW_A));
		}).toPass({ timeout: 15_000 });

		// Up on beta brings it back to the top (up branch).
		await rowByName(page, ROW_B).getByRole('button', { name: '上移' }).click({ timeout: 5000 });
		await expect(async () => {
			expect(sortOf(ROW_B)).toBeLessThan(sortOf(ROW_A));
		}).toPass({ timeout: 15_000 });

		// The admin list renders in the stored order (review: no assertion
		// ever watched the admin-side order).
		const adminOrder = await page
			.locator('li')
			.evaluateAll(
				(elements, [a, b]) =>
					[
						elements.findIndex((el) => el.textContent?.includes(a as string)),
						elements.findIndex((el) => el.textContent?.includes(b as string))
					] as [number, number],
				[ROW_B, ROW_A]
			);
		expect(adminOrder[0]).toBeGreaterThanOrEqual(0);
		expect(adminOrder[1]).toBeGreaterThan(adminOrder[0]);

		// Public grid shows beta before alpha (T12).
		await page.goto('/zh-cn/projects');
		const publicOrder = await page
			.locator('[role="listitem"]')
			.evaluateAll(
				(elements, [a, b]) =>
					[
						elements.findIndex((el) => el.textContent?.includes(a as string)),
						elements.findIndex((el) => el.textContent?.includes(b as string))
					] as [number, number],
				[ROW_B, ROW_A]
			);
		expect(publicOrder[0]).toBeGreaterThanOrEqual(0);
		expect(publicOrder[1]).toBeGreaterThan(publicOrder[0]);
	});

	test('edits a row through the dialog and refuses a duplicate URL', async ({ page }) => {
		await page.goto('/admin/projects?status=published');
		const row = rowByName(page, ROW_A);
		await expect(row).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			await row.getByRole('button', { name: '编辑项目' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog', { name: '编辑项目' })).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 15_000 });
		const dialog = page.getByRole('dialog');

		// Edit the description; the dialog closes and the row persists it.
		await dialog.getByLabel('描述').fill('e2e 描述 v2');
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 5000 });
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText('项目已更新。')).toBeVisible({ timeout: 20_000 });
		expect(psql(`select description from projects where name = '${ROW_A}'`)).toBe('e2e 描述 v2');

		// Duplicate URL on the update path: 400, not a 500 (review P2).
		await expect(async () => {
			await row.getByRole('button', { name: '编辑项目' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog', { name: '编辑项目' })).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 15_000 });
		await dialog.getByLabel('主链接').fill('https://beta.example');
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 5000 });
		await expect(dialog.getByText('已存在相同链接或仓库')).toBeVisible({ timeout: 20_000 });
		await page.keyboard.press('Escape');
	});

	test('enqueues the sync (zero-target guard first), dedups and shows the run card', async ({
		page
	}) => {
		await page.goto('/admin/projects');

		// Scenario #1 (§0.1): with no targets the guard steers to the editor.
		await expect(async () => {
			await page.getByRole('button', { name: '同步', exact: true }).click({ timeout: 5000 });
			await expect(page.getByText('请先在「同步目标」中添加至少一个账号')).toBeVisible({
				timeout: 5000
			});
		}).toPass({ timeout: 20_000 });
		expect(
			psql(`select count(*) from job_runs where job = 'projects.sync' and status = 'queued'`)
		).toBe('0');

		psql(
			`insert into options (name, value) values ('${TARGETS_OPTION}', '[{"provider":"github","account":"e2e-account"}]'::jsonb) on conflict (name) do update set value = excluded.value`
		);
		await page.reload();
		await expect(async () => {
			await page.getByRole('button', { name: '同步', exact: true }).click({ timeout: 5000 });
			await expect(page.getByText('同步已入队——drain 将执行本次运行。')).toBeVisible({
				timeout: 5000
			});
		}).toPass({ timeout: 20_000 });
		expect(
			psql(`select count(*) from job_runs where job = 'projects.sync' and status = 'queued'`)
		).toBe('1');
		await expect(page.getByText('排队中')).toBeVisible({ timeout: 20_000 });

		await expect(async () => {
			await page.getByRole('button', { name: '同步', exact: true }).click({ timeout: 5000 });
			await expect(page.getByText('已有一次同步在队列中。')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		expect(
			psql(`select count(*) from job_runs where job = 'projects.sync' and status = 'queued'`)
		).toBe('1');
	});

	test('persists sync targets, refuses case-variant duplicates and holds the removal copy', async ({
		page
	}) => {
		await page.goto('/admin/projects');
		await expect(async () => {
			await page.getByRole('button', { name: '同步目标' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		const dialog = page.getByRole('dialog');
		// The §4.3 removal semantics copy is rendered in the dialog.
		await expect(dialog.getByText('移除账号只会停止后续拉取；已入库的行不受影响。')).toBeVisible();
		await dialog.getByRole('button', { name: '添加账号' }).click({ timeout: 5000 });
		await dialog.getByLabel('账号').nth(1).fill('e2e-account-2');
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 5000 });
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText('同步目标已保存。')).toBeVisible({ timeout: 20_000 });
		expect(
			psql(
				`select value from options where name = '${TARGETS_OPTION}' and value::text like '%e2e-account-2%'`
			)
		).toContain('e2e-account-2');

		// A case-variant of an existing account is refused (review P2).
		await expect(async () => {
			await page.getByRole('button', { name: '同步目标' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		await dialog.getByRole('button', { name: '添加账号' }).click({ timeout: 5000 });
		await dialog.getByLabel('账号').nth(2).fill('E2E-ACCOUNT');
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 5000 });
		await expect(
			dialog.getByText('同步目标校验失败：账号不能为空，同一平台账号不可重复')
		).toBeVisible({ timeout: 20_000 });
		await page.keyboard.press('Escape');
	});

	test('import dialog surfaces error paths without leaving the page', async ({ page }) => {
		await page.goto('/admin/projects');
		await expect(async () => {
			await page.getByRole('button', { name: '从链接导入' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('链接').fill('not-a-url');
		await dialog.getByRole('button', { name: '获取元数据' }).click({ timeout: 5000 });
		await expect(dialog.getByText('链接无效（需要 https 地址）')).toBeVisible({
			timeout: 20_000
		});
		await dialog.getByLabel('链接').fill('https://nx.invalid/page');
		await dialog.getByRole('button', { name: '获取元数据' }).click({ timeout: 5000 });
		await expect(dialog.getByText('网络错误，请稍后再试')).toBeVisible({ timeout: 30_000 });
	});

	test('bulk delete: the cancel path keeps the rows, the skipped flash bites, confirm deletes', async ({
		page
	}) => {
		psql(`update projects set status = 'published' where name like '${FIX}%'`);
		await page.goto('/admin/projects?status=published');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });

		// Already-published row selected for approve -> updated 0 / skipped 1.
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '通过' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 0 项，跳过 1 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('published');
		// The enhanced bulk form keeps the filtered view (a native POST used to
		// replace ?status= with the action URL) and clears the selection.
		await expect(page).toHaveURL(/status=published/);
		await expect(page.getByText('已选', { exact: false })).toHaveCount(0);

		// Cancel inside the bulk-delete confirm must NOT delete (review P1:
		// a cancel button inside the destructive form used to submit).
		await toggleRow(page, ROW_A);
		await toggleRow(page, ROW_B);
		await page.getByRole('button', { name: '删除', exact: true }).first().click({
			timeout: 5000
		});
		const confirm = page.getByRole('alertdialog');
		await expect(confirm).toBeVisible({ timeout: 5000 });
		await confirm.getByRole('button', { name: '取消' }).click({ timeout: 5000 });
		await expect(confirm).toBeHidden({ timeout: 10_000 });
		expect(psql(`select count(*) from projects where name like '${FIX}%'`)).toBe('2');

		// Confirm deletes for real.
		await page.getByRole('button', { name: '删除', exact: true }).first().click({
			timeout: 5000
		});
		await expect(confirm).toBeVisible({ timeout: 5000 });
		await confirm.getByRole('button', { name: '删除' }).click({ timeout: 5000 });
		await expect(page.getByText('项目已删除。')).toBeVisible({ timeout: 20_000 });
		expect(psql(`select count(*) from projects where name like '${FIX}%'`)).toBe('0');
	});
});
