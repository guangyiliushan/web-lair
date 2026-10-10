import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
// Same resolver contract as the app (J-3 review J3-9): an explicit DATA_DIR
// wins (absolute or cwd-relative), otherwise the dev default <repo>/data.
const DATA_DIR = process.env.DATA_DIR?.trim()
	? resolve(process.cwd(), process.env.DATA_DIR.trim())
	: join(process.cwd(), 'data');
const JOBS_DIR = join(DATA_DIR, 'jobs');

function jobFilePath(): string {
	return join(JOBS_DIR, `${JOB}.ts`);
}

function jobSidecarPath(): string {
	return join(JOBS_DIR, '.meta', `${JOB}.json`);
}

// The builtin-fork fixture (test 9): a user copy of jobs.prune created and
// removed around the case.
function pruneFilePath(): string {
	return join(JOBS_DIR, 'jobs-prune.ts');
}

function pruneSidecarPath(): string {
	return join(JOBS_DIR, '.meta', 'jobs-prune.json');
}

function cleanupFs(): void {
	rmSync(jobFilePath(), { force: true });
	rmSync(jobSidecarPath(), { force: true });
	rmSync(pruneFilePath(), { force: true });
	rmSync(pruneSidecarPath(), { force: true });
}

function cleanupDb(): void {
	psql(`delete from job_schedules where job like 'e2e-jobs-%'`);
	psql(
		`delete from activities where payload->>'name' = 'jobs.prune' and created_at > now() - interval '2 hours'`
	);
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
		// init (~10s, longer under load): one click with a generous navigation
		// budget, then poll for the landing (never abandon the POST mid-navigation).
		await page.getByRole('button', { name: '保存', exact: true }).click({ timeout: 60_000 });
		// The POST is now fetch-based (use:enhance), so the click resolves
		// immediately and THIS poll carries the whole cold gate init (~10s
		// warm, minutes under load) - keep the budget generous.
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 90_000 })
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
		// The rejected save wrote nothing: the file still holds the template
		// (content, not just existence - J-3 review J3-9).
		expect(readFileSync(jobFilePath(), 'utf8')).toContain('hello from a new job');
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

		// A duplicate create answers 409 and the flash SHOWS it (J-3 review
		// R4-1: failures must be visible, not just returned).
		await expect(async () => {
			await card.locator('summary', { hasText: '添加调度…' }).click({ timeout: 5000 });
			await card.getByPlaceholder('0 4 * * *').fill(CRON);
			await card.getByRole('button', { name: '添加' }).click({ timeout: 5000 });
			await expect(page.locator('[data-slot="maintenance-flash"]')).toContainText(
				'该任务已有一条相同 cron 的调度',
				{ timeout: 5000 }
			);
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
			.poll(() => new URL(page.url()).pathname, { timeout: 60_000 })
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
	test('a stale baseHash freezes the editor; 载入服务端最新 adopts the server state', async ({
		page
	}) => {
		// Fixture: the file exists as server-v1; the editor loads its hash. An
		// external write moves the file to server-v2 - the editor's save must
		// 409, freeze (no silent overwrite), and recover only through the
		// explicit reload (J-3 review F1 activation: with use:enhance the
		// buffer survives the rejected save instead of a page reload adopting
		// the disk file).
		mkdirSync(JOBS_DIR, { recursive: true });
		writeFileSync(jobFilePath(), 'export default { run() {} }; // server-v1\n', 'utf8');
		await page.goto(`/admin/maintenance/${JOB}`);
		// .cm-content only exists after hydration + the editor's dynamic
		// import, so its visibility is also the hydration gate for the click.
		await expect(page.locator('.cm-content')).toContainText('server-v1', { timeout: 20_000 });
		writeFileSync(jobFilePath(), 'export default { run() {} }; // server-v2\n', 'utf8');

		await page.getByRole('button', { name: '保存', exact: true }).click({ timeout: 10_000 });
		await expect(page.locator('[data-slot="maintenance-flash"]')).toContainText('保存已暂停', {
			timeout: 10_000
		});
		// The freeze disables both save buttons (J-3 review F3).
		await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
		// The buffer must NOT adopt the disk file - that retention is the F1
		// delta versus the old native POST (which reloaded and showed v2).
		await expect(page.locator('.cm-content')).toContainText('server-v1');
		// The rejected save wrote nothing - the external v2 survives.
		expect(readFileSync(jobFilePath(), 'utf8')).toContain('server-v2');

		await page.getByRole('button', { name: /载入服务端最新/ }).click();
		await expect(page.locator('[data-slot="maintenance-flash"]')).toHaveCount(0, {
			timeout: 10_000
		});
		await expect(page.locator('.cm-content')).toContainText('server-v2', { timeout: 10_000 });
		await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
	});
	test('forking a builtin keeps the saved flash through the invalidation (J-3 复核 v2 #1)', async ({
		page
	}) => {
		// No user copy of jobs.prune: the editor shows the builtin, and the
		// first save forks it (created+forked) - the one path that triggers the
		// created/forked invalidation, whose ordering must preserve the flash.
		rmSync(pruneFilePath(), { force: true });
		rmSync(pruneSidecarPath(), { force: true });
		await page.goto('/admin/maintenance/jobs.prune');
		// CodeMirror virtualizes: only the top viewport renders, so gate on
		// a line that is certainly visible (the #jobs-sdk import head).
		await expect(page.locator('.cm-content')).toContainText('jobs-sdk', {
			timeout: 20_000
		});

		await page.getByRole('button', { name: '保存', exact: true }).click({ timeout: 10_000 });
		await expect(page.locator('[data-slot="maintenance-flash"]')).toContainText('已保存', {
			timeout: 60_000
		});
		// A stale form would be cleared by the invalidation; after the settle
		// delay the flash must still be there (kit#13825 ordering).
		await page.waitForTimeout(1500);
		await expect(page.locator('[data-slot="maintenance-flash"]')).toContainText('已保存');
		await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
	});
});
