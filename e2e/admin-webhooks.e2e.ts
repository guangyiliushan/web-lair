import { expect, test, type Page } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * SY acceptance: the Webhooks endpoint CRUD on the real database plus the
 * event-to-queue smoke. No drain process runs here (J-3 precedent: a row
 * staying queued IS the observable evidence; tick delivery semantics live in
 * `pnpm db:verify-jobs`). Everything is marker-prefixed - endpoints are
 * removed by name (their deliveries cascade via the FK), the schedule
 * fixture by its (job, cron) pair.
 */

const HOOK = 'e2e-sy-hook';
const HOOK_RENAMED = 'e2e-sy-target';
const HOOK_URL = 'https://example.com/e2e-sy';
const MARKER_CRON = '37 5 * * *';

function cleanupDb(): void {
	psql(`delete from job_schedules where job = 'jobs.prune' and cron_expr = '${MARKER_CRON}'`);
	psql(
		`delete from activities where payload->>'cron_expr' = '${MARKER_CRON}' and created_at > now() - interval '2 hours'`
	);
	psql(`delete from webhooks where name like 'e2e-sy-%'`);
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use(zhCnLocale);

test.beforeAll(() => {
	cleanupDb();
});

test.afterAll(async () => {
	cleanupDb();
	// A late-landing POST must not outlive the cleanup (maintenance precedent).
	await new Promise((resolve) => setTimeout(resolve, 2000));
	cleanupDb();
});

test.describe('SY webhooks (admin)', () => {
	// The settings shell renders a mobile and a desktop branch (one is
	// display:none): role queries skip hidden nodes, CSS/text ones must
	// filter to the visible copy (J-3 precedent).
	const endpointRow = (page: Page, name: string) =>
		page
			.locator('[data-slot="endpoint-row"]')
			.filter({ visible: true })
			.filter({ hasText: name })
			.first();

	test('create: dialog -> generated secret revealed once -> masked row', async ({ page }) => {
		await page.goto('/admin/settings/notification');
		await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible({ timeout: 20_000 });

		await page.getByRole('button', { name: '新建端点' }).click({ timeout: 10_000 });
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		// The event picker is roster-driven: all nine v1 events, as checkboxes.
		await expect(dialog.getByRole('checkbox')).toHaveCount(9);
		await dialog.getByLabel('名称').fill(HOOK);
		await dialog.getByLabel('回调地址').fill(HOOK_URL);
		await dialog.getByLabel('schedule.create').check();
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 10_000 });

		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(
			page.locator('[data-slot="webhook-flash"]').filter({ visible: true })
		).toContainText('端点已创建', { timeout: 20_000 });
		// The one-time reveal: the FULL raw secret + the copy-now hint.
		const reveal = page.locator('[data-slot="secret-reveal"]').filter({ visible: true });
		await expect(reveal).toBeVisible();
		await expect(reveal).toContainText('whsec_');
		await expect(reveal).toContainText('只会显示这一次');

		// DB truth: generated secret + the roster event; the reveal shows the
		// SAME value as the DB (a masked or stale reveal must turn this red).
		expect(
			psql(
				`select secret like 'whsec_%' and events = '{schedule.create}' from webhooks where name = '${HOOK}'`
			)
		).toBe('t');
		const raw = psql(`select secret from webhooks where name = '${HOOK}'`);
		await expect(reveal).toContainText(raw);

		// A fresh load: the reveal is gone, the row shows the mask only, and
		// the raw secret appears NOWHERE in the rendered markup.
		await page.goto('/admin/settings/notification');
		const row = endpointRow(page, HOOK);
		await expect(row).toBeVisible({ timeout: 20_000 });
		await expect(row).toContainText('whsec_…');
		await expect(page.locator('[data-slot="secret-reveal"]')).toHaveCount(0);
		expect((await page.content()).includes(raw)).toBe(false);
	});

	test('create negative: a duplicate name is soft-rejected inside the dialog', async ({ page }) => {
		await page.goto('/admin/settings/notification');
		await page.getByRole('button', { name: '新建端点' }).click({ timeout: 10_000 });
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('名称').fill(HOOK);
		await dialog.getByLabel('回调地址').fill(HOOK_URL);
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 10_000 });
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('已存在同名端点', { timeout: 10_000 });
		expect(psql(`select count(*) from webhooks where name = '${HOOK}'`)).toBe('1');
		// Case-insensitive too: the same name in caps is refused as well.
		await dialog.getByLabel('名称').fill(HOOK.toUpperCase());
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 10_000 });
		await expect(dialog).toContainText('已存在同名端点');
		expect(psql(`select count(*) from webhooks where name ilike '${HOOK}'`)).toBe('1');
		await dialog.getByRole('button', { name: '取消' }).click();
		await expect(dialog).toBeHidden();
	});

	test('edit: the dialog prefills and saving renames the endpoint', async ({ page }) => {
		await page.goto('/admin/settings/notification');
		const row = endpointRow(page, HOOK);
		await expect(row).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			await row.getByRole('button', { name: '编辑' }).click({ timeout: 5000 });
			const dialog = page.getByRole('dialog');
			await expect(dialog.getByLabel('名称')).toHaveValue(HOOK, { timeout: 5000 });
			// Saving the unchanged name must pass: the dup check excludes self.
			await dialog.getByRole('button', { name: '保存' }).click({ timeout: 5000 });
			await expect(dialog).toBeHidden({ timeout: 5000 });
			expect(psql(`select count(*) from webhooks where name = '${HOOK}'`)).toBe('1');
			// Then the actual rename.
			await endpointRow(page, HOOK).getByRole('button', { name: '编辑' }).click({ timeout: 5000 });
			await dialog.getByLabel('名称').fill(HOOK_RENAMED);
			await dialog.getByRole('button', { name: '保存' }).click({ timeout: 5000 });
			await expect(dialog).toBeHidden({ timeout: 5000 });
		}).toPass({ timeout: 60_000 });
		await expect(
			page.locator('[data-slot="webhook-flash"]').filter({ visible: true })
		).toContainText('端点已更新');
		expect(psql(`select count(*) from webhooks where name = '${HOOK_RENAMED}'`)).toBe('1');
		expect(psql(`select count(*) from webhooks where name = '${HOOK}'`)).toBe('0');
	});

	test('toggle: disable then re-enable persists', async ({ page }) => {
		await page.goto('/admin/settings/notification');
		const row = endpointRow(page, HOOK_RENAMED);
		await expect(row).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			await row.getByRole('button', { name: '停用' }).click({ timeout: 5000 });
			await expect(row.getByRole('button', { name: '启用' })).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 30_000 });
		expect(psql(`select is_enabled from webhooks where name = '${HOOK_RENAMED}'`)).toBe('f');
		await expect(async () => {
			await row.getByRole('button', { name: '启用' }).click({ timeout: 5000 });
			await expect(row.getByRole('button', { name: '停用' })).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 30_000 });
		expect(psql(`select is_enabled from webhooks where name = '${HOOK_RENAMED}'`)).toBe('t');
	});

	test('pipeline smoke: a schedule.create event queues a delivery (no drain)', async ({ page }) => {
		// The endpoint subscribes to schedule.create; adding a schedule on the
		// builtin jobs.prune card emits exactly that audit event.
		await page.goto('/admin/maintenance');
		const card = page.locator('[data-slot="script-card"]').filter({ hasText: 'jobs.prune' });
		await expect(async () => {
			await card.locator('summary', { hasText: '添加调度…' }).click({ timeout: 5000 });
			await card.getByPlaceholder('0 4 * * *').fill(MARKER_CRON);
			await card.getByRole('button', { name: '添加' }).click({ timeout: 5000 });
			await expect(
				card.locator('[data-slot="schedule-row"]').filter({ hasText: MARKER_CRON })
			).toBeVisible({
				timeout: 5000
			});
		}).toPass({ timeout: 30_000 });

		await expect
			.poll(
				() =>
					psql(
						`select count(*) from webhook_deliveries d join webhooks w on w.id = d.webhook_id where w.name = '${HOOK_RENAMED}' and d.event = 'schedule.create' and d.status = 'queued'`
					),
				{ timeout: 20_000 }
			)
			.toBe('1');

		await page.goto('/admin/settings/notification');
		const deliveryRow = page
			.locator('[data-slot="delivery-row"]')
			.filter({ visible: true })
			.filter({ hasText: HOOK_RENAMED })
			.filter({ hasText: '排队' });
		await expect(deliveryRow.first()).toBeVisible({ timeout: 20_000 });
	});

	test('rotate: confirm issues a fresh secret, the mask changes', async ({ page }) => {
		await page.goto('/admin/settings/notification');
		const row = endpointRow(page, HOOK_RENAMED);
		await expect(row).toBeVisible({ timeout: 20_000 });
		const before = psql(`select secret from webhooks where name = '${HOOK_RENAMED}'`);
		await expect(async () => {
			await row.getByRole('button', { name: '轮换密钥' }).click({ timeout: 5000 });
			const confirm = page.getByRole('alertdialog');
			await expect(confirm).toBeVisible({ timeout: 5000 });
			await confirm.getByRole('button', { name: '轮换密钥' }).click({ timeout: 5000 });
			await expect(confirm).toBeHidden({ timeout: 5000 });
		}).toPass({ timeout: 60_000 });
		await expect(
			page.locator('[data-slot="secret-reveal"]').filter({ visible: true })
		).toContainText('whsec_');
		const after = psql(`select secret from webhooks where name = '${HOOK_RENAMED}'`);
		expect(after.startsWith('whsec_')).toBe(true);
		expect(after).not.toBe(before);
		// The rotated reveal shows the NEW value itself, not a mask.
		await expect(
			page.locator('[data-slot="secret-reveal"]').filter({ visible: true })
		).toContainText(after);
	});

	test('delete: confirm removes the endpoint and its delivery log cascades', async ({ page }) => {
		const hookId = psql(`select id from webhooks where name = '${HOOK_RENAMED}'`);
		expect(hookId).toMatch(/^[0-9a-f-]{36}$/);
		await page.goto('/admin/settings/notification');
		const row = endpointRow(page, HOOK_RENAMED);
		await expect(row).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			await row.getByRole('button', { name: '删除' }).click({ timeout: 5000 });
			const confirm = page.getByRole('alertdialog');
			await expect(confirm).toBeVisible({ timeout: 5000 });
			await confirm.getByRole('button', { name: '删除' }).click({ timeout: 5000 });
			await expect(confirm).toBeHidden({ timeout: 5000 });
		}).toPass({ timeout: 60_000 });
		await expect(
			page.locator('[data-slot="webhook-flash"]').filter({ visible: true })
		).toContainText('端点已删除');
		expect(psql(`select count(*) from webhooks where name = '${HOOK_RENAMED}'`)).toBe('0');
		// The FK cascade removed the delivery log with the endpoint.
		expect(psql(`select count(*) from webhook_deliveries where webhook_id = '${hookId}'`)).toBe(
			'0'
		);
	});
});
