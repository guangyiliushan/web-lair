import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * J-3 acceptance: the maintenance surface against the real database - list
 * render (registry ∪ user layer), the create → editor → delete lifecycle of a
 * user-only job, the save gate's line-numbered rejection, schedule CRUD, the
 * save-and-run enqueue, and the webhook retry button. No drain process runs
 * here: a queued row staying queued IS the observable evidence (tick
 * semantics live in db:verify-jobs). Everything is marker-prefixed
 * (`e2e-jobs-*`): DB rows are deleted by prefix and the job file lives in
 * <worktree>/data/jobs (the dev DATA_DIR default) and is removed around the
 * run.
 */

const JOB = 'e2e-jobs-task';
const CRON = '*/30 * * * *';
const HOOK = 'e2e-jobs-hook';
const JOBS_DIR = join(process.cwd(), 'data', 'jobs');

function jobFilePath(): string {
	return join(JOBS_DIR, `${JOB}.ts`);
}

function jobSidecarPath(): string {
	return join(JOBS_DIR, '.meta', `${JOB}.json`);
}

function cleanupFs(): void {
	rmSync(jobFilePath(), { force: true });
	rmSync(jobSidecarPath(), { force: true });
}

function cleanupDb(): void {
	psql(`delete from job_schedules where job like 'e2e-jobs-%'`);
	psql(`delete from job_runs where job like 'e2e-jobs-%'`);
	psql(
		`delete from activities where payload->>'name' like 'e2e-jobs-%' or payload->>'job' like 'e2e-jobs-%'`
	);
	psql(`delete from webhooks where name = '${HOOK}'`);
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use(zhCnLocale);

test.beforeAll(() => {
	cleanupDb();
	cleanupFs();
	psql(
		`insert into webhooks (name, payload_url, events, secret, is_enabled) values ('${HOOK}', 'https://example.com/e2e-hook', '{comment.created}', 'e2e-secret', true)`
	);
	const hookId = psql(`select id from webhooks where name = '${HOOK}'`);
	psql(
		`insert into webhook_deliveries (webhook_id, event, payload, status, response_code, error) values ('${hookId}', 'comment.created', '{"e2e":true}', 'failed', 500, 'e2e 夹具：模拟投递失败')`
	);
});

test.afterAll(async () => {
	cleanupDb();
	cleanupFs();
	// A late-landing POST must not outlive the cleanup (observed once when a
	// cold save was abandoned mid-navigation): settle, then clean again.
	await new Promise((resolve) => setTimeout(resolve, 2000));
	cleanupDb();
	cleanupFs();
});

test.describe('J-3 maintenance (admin)', () => {
	test('list renders the platform overview with registry cards', async ({ page }) => {
		await page.goto('/admin/maintenance');
		await expect(
			page.locator('[data-slot="script-card"]').filter({ hasText: 'jobs.prune' })
		).toBeVisible({
			timeout: 20_000
		});
		await expect(
			page.locator('[data-slot="script-card"]').filter({ hasText: 'system.resources' })
		).toBeVisible();
		await expect(page.getByRole('heading', { name: '运行台账' })).toBeVisible();
		await expect(page.getByRole('heading', { name: '审计（job / schedule 事件）' })).toBeVisible();
	});

	test('create a user job, land on its editor, then find it in the list', async ({ page }) => {
		await page.goto('/admin/maintenance/new');
		await page.getByLabel(/任务名/).fill(JOB);
		// The first save in a fresh server process runs the gate's cold module
		// init (~10s): one click with a generous navigation budget, then poll
		// for the landing (never abandon the POST mid-navigation).
		await page.getByRole('button', { name: '保存', exact: true }).click({ timeout: 30_000 });
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
			.toBe(`/admin/maintenance/${JOB}`);
		// File on disk (LF, template), then the list shows the user badge.
		expect(existsSync(jobFilePath())).toBe(true);
		await page.goto('/admin/maintenance');
		await expect(
			page.locator('[data-slot="script-card"]').filter({ hasText: JOB }).getByText('用户')
		).toBeVisible({ timeout: 20_000 });
	});

	test('save gate rejects an enum with line info and keeps the file', async ({ page }) => {
		await page.goto(`/admin/maintenance/${JOB}`);
		await expect(async () => {
			await page.locator('.cm-content').click({ timeout: 5000 });
			await page.keyboard.press('ControlOrMeta+a');
			await page.keyboard.type('enum E { A }\n');
			await page.getByRole('button', { name: '保存', exact: true }).click({ timeout: 5000 });
			await expect(page.locator('[data-slot="gate-errors"]')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 30_000 });
		await expect(page.locator('[data-slot="gate-errors"]')).toContainText('1:6');
		// The rejected save wrote nothing: the file still holds the template.
		expect(existsSync(jobFilePath())).toBe(true);
	});

	test('schedule CRUD: add → disable → delete through the card', async ({ page }) => {
		await page.goto('/admin/maintenance');
		const card = page.locator('[data-slot="script-card"]').filter({ hasText: JOB });
		await expect(async () => {
			await card.locator('summary', { hasText: '添加调度…' }).click({ timeout: 5000 });
			await card.getByPlaceholder('0 4 * * *').fill(CRON);
			await card.getByRole('button', { name: '添加' }).click({ timeout: 5000 });
			await expect(card.locator('[data-slot="schedule-row"]')).toContainText(CRON, {
				timeout: 5000
			});
		}).toPass({ timeout: 30_000 });
		expect(psql(`select count(*) from job_schedules where job = '${JOB}'`)).toBe('1');

		const row = card.locator('[data-slot="schedule-row"]').filter({ hasText: CRON });
		await expect(async () => {
			await row.getByRole('button', { name: '停用' }).click({ timeout: 5000 });
			// The toggle button flips to 启用 only once is_enabled=false; the
			// badge alone would also match the pre-click button text.
			await expect(row.getByRole('button', { name: '启用' })).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 30_000 });
		expect(psql(`select is_enabled from job_schedules where job = '${JOB}'`)).toBe('f');

		await expect(async () => {
			await row.getByRole('button', { name: '删除' }).click({ timeout: 5000 });
			await expect(
				card.locator('[data-slot="schedule-row"]').filter({ hasText: CRON })
			).toHaveCount(0, {
				timeout: 5000
			});
		}).toPass({ timeout: 30_000 });
		expect(psql(`select count(*) from job_schedules where job = '${JOB}'`)).toBe('0');
	});

	test('保存并试运行 queues a manual run visible in the ledger', async ({ page }) => {
		await page.goto(`/admin/maintenance/${JOB}`);
		await page.getByRole('button', { name: '保存并试运行' }).click({ timeout: 30_000 });
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
			.toBe('/admin/maintenance');
		expect(
			psql(`select status from job_runs where job = '${JOB}' order by created_at desc limit 1`)
		).toBe('queued');
		await page.goto(`/admin/maintenance?job=${JOB}`);
		await expect(page.locator('[data-slot="run-row"]').first()).toContainText(JOB, {
			timeout: 20_000
		});
	});

	test('delete lifecycle removes the file, its schedule and the queued row', async ({ page }) => {
		// Re-create a schedule so the delete cascade has something to clean.
		psql(
			`insert into job_schedules (job, cron_expr, tz, is_enabled, last_due_at) values ('${JOB}', '${CRON}', 'Etc/UTC', true, now())`
		);
		await page.goto(`/admin/maintenance/${JOB}`);
		await expect(async () => {
			await page.getByRole('button', { name: '删除', exact: true }).click({ timeout: 5000 });
			await page
				.getByRole('alertdialog')
				.getByRole('button', { name: '删除' })
				.click({ timeout: 5000 });
			await expect
				.poll(() => new URL(page.url()).pathname, { timeout: 5000 })
				.toBe('/admin/maintenance');
		}).toPass({ timeout: 60_000 });
		expect(existsSync(jobFilePath())).toBe(false);
		expect(psql(`select count(*) from job_schedules where job = '${JOB}'`)).toBe('0');
		expect(psql(`select count(*) from job_runs where job = '${JOB}' and status = 'queued'`)).toBe(
			'0'
		);
		await expect(page.locator('[data-slot="script-card"]').filter({ hasText: JOB })).toHaveCount(
			0,
			{ timeout: 20_000 }
		);
	});

	test('webhook retry copies the failed delivery into a queued row', async ({ page }) => {
		await page.goto('/admin/settings/notification');
		await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible({ timeout: 20_000 });
		const row = page
			.locator('[data-slot="delivery-row"]')
			// The settings shell renders mobile and desktop branches (one is
			// display:none); CSS selectors hit both - scope to the visible copy.
			.filter({ visible: true })
			.filter({ hasText: HOOK });
		await expect(row).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			await row.getByRole('button', { name: '重投' }).click({ timeout: 5000 });
			// Same double-render shadow: scope the flash to the visible copy.
			await expect(page.getByText(/已重投/).filter({ visible: true })).toBeVisible({
				timeout: 5000
			});
		}).toPass({ timeout: 30_000 });
		expect(
			psql(
				`select count(*) from webhook_deliveries d join webhooks w on w.id = d.webhook_id where w.name = '${HOOK}' and d.status = 'queued'`
			)
		).toBe('1');
		// The fresh queued row renders without a retry button.
		const queuedRow = page
			.locator('[data-slot="delivery-row"]')
			.filter({ visible: true })
			.filter({ hasText: HOOK })
			.filter({ hasText: '排队' });
		await expect(queuedRow).toBeVisible({ timeout: 20_000 });
		await expect(queuedRow.getByRole('button', { name: '重投' })).toHaveCount(0);
	});
});
