import { execFileSync } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * AI admin surface (AI-2) - owner flow against the real pages and database:
 * providers CRUD, the connection probe, assignments, moderation settings and
 * the memory-card round trip. The localhost origin auto-authenticates as the
 * site owner (see auth.e2e.ts / TAILSCALE_ALLOW_LOOPBACK).
 *
 * Two repo-proven hazards are handled here:
 * - The settings shell renders its children twice (mobile + desktop
 *   branches, one hidden by CSS). Role locators only see the accessibility
 *   tree (hidden copies are excluded), but text/CSS locators see both, so
 *   those are filtered to the visible one.
 * - Any click on a control that exists in the SSR HTML must retry until the
 *   state actually flips (SvelteKit attaches handlers after hydration; under
 *   load the first click is swallowed) - hence the toPass loops below.
 */
const PROVIDER = 'E2E Provider';
const MEMORY_TEXT = 'E2E memory card: keep the tone dry.';

function byText(page: Page, text: string | RegExp): Locator {
	return page.getByText(text).filter({ visible: true });
}

function vis(locator: Locator): Locator {
	return locator.filter({ visible: true });
}

function psql(sql: string): string {
	return execFileSync(
		'docker',
		['exec', '-i', 'web-lair-db-1', 'psql', '-U', 'root', '-d', 'local', '-tAc', sql],
		{ encoding: 'utf8' }
	).trim();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
	psql(`delete from ai_providers where name = '${PROVIDER}'`);
	psql(
		`delete from options where name in ('ai.assignments', 'comments.moderation', 'ai.budget', 'ai.styleGuide')`
	);
	psql(`delete from ai_agent_memories where content like 'E2E memory card%'`);
});

test.afterAll(() => {
	psql(`delete from ai_providers where name = '${PROVIDER}'`);
	psql(
		`delete from options where name in ('ai.assignments', 'comments.moderation', 'ai.budget', 'ai.styleGuide')`
	);
	psql(`delete from ai_agent_memories where content like 'E2E memory card%'`);
});

test('the settings page renders the three AI sections', async ({ page }) => {
	await page.goto('/admin/settings/ai');
	await expect(page.getByRole('button', { name: '添加服务商' })).toBeVisible({
		timeout: 10000
	});
	await expect(byText(page, '功能位分配')).toBeVisible();
	await expect(byText(page, '开关与阈值')).toBeVisible();
	await expect(byText(page, '评论分诊（审核）')).toBeVisible();
});

test('creates a provider, probes it, and lists it', async ({ page }) => {
	await page.goto('/admin/settings/ai');

	// Open the dialog, retrying the click until it actually opens (hydration).
	const dialog = page.getByRole('dialog');
	await expect(async () => {
		if (!(await dialog.isVisible())) {
			await page.getByRole('button', { name: '添加服务商' }).click();
		}
		await expect(dialog).toBeVisible();
	}).toPass({ timeout: 20000 });

	await dialog.getByLabel('名称').fill(PROVIDER);
	await dialog.getByLabel('密钥环境变量名').fill('E2E_MISSING_KEY');
	await dialog.getByLabel('模型列表').fill('e2e-model-a');
	await dialog.getByRole('button', { name: '保存' }).click();

	await expect(byText(page, PROVIDER)).toBeVisible({ timeout: 10000 });
	expect(psql(`select count(*) from ai_providers where name = '${PROVIDER}'`)).toBe('1');

	// The connection probe reports the missing env var instead of calling out.
	await expect(async () => {
		if (!(await byText(page, /E2E_MISSING_KEY 未设置/).isVisible())) {
			await page.getByRole('button', { name: '测试连接' }).click();
		}
		await expect(byText(page, /E2E_MISSING_KEY 未设置/)).toBeVisible();
	}).toPass({ timeout: 20000 });
});

test('assigns the provider to a feature slot and persists it', async ({ page }) => {
	await page.goto('/admin/settings/ai');
	// bits-ui's Select trigger carries data-slot attributes, not a combobox role.
	const form = vis(page.locator('form[action="?/saveAssignments"]'));

	await expect(async () => {
		if (!(await page.locator('[data-slot="select-item"]').first().isVisible())) {
			await form.locator('[data-slot="select-trigger"]').first().click();
		}
		await expect(page.locator('[data-slot="select-item"]').first()).toBeVisible();
	}).toPass({ timeout: 20000 });
	await page.locator('[data-slot="select-item"]', { hasText: PROVIDER }).click();

	await expect(async () => {
		if (!(await byText(page, '功能位分配已保存').isVisible())) {
			await form.getByRole('button', { name: '保存分配' }).click();
		}
		await expect(byText(page, '功能位分配已保存')).toBeVisible();
	}).toPass({ timeout: 20000 });
	expect(
		psql(`select value->'summary'->>'provider' from options where name = 'ai.assignments'`)
	).toBe(PROVIDER);
});

test('saves the moderation switches and thresholds', async ({ page }) => {
	await page.goto('/admin/settings/ai');

	const toggle = page.getByRole('switch', { name: '启用 AI 分诊' });
	await expect(async () => {
		if ((await toggle.getAttribute('aria-checked')) !== 'true') {
			await toggle.click();
		}
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
	}).toPass({ timeout: 20000 });

	await vis(page.locator('#mod-link-threshold')).fill('3');
	await expect(async () => {
		if (!(await byText(page, '审核设置已保存').isVisible())) {
			await page.getByRole('button', { name: '保存审核设置' }).click();
		}
		await expect(byText(page, '审核设置已保存')).toBeVisible();
	}).toPass({ timeout: 20000 });

	expect(
		psql(
			`select (value->>'enabled') || '|' || (value->>'linkThreshold') from options where name = 'comments.moderation'`
		)
	).toBe('true|3');
});

test('the AI console shows its empty states', async ({ page }) => {
	await page.goto('/admin/ai');
	await expect(page.getByText('还没有对话')).toBeVisible({ timeout: 10000 });

	await expect(async () => {
		if (!(await page.getByText('暂无用量记录').isVisible())) {
			await page.getByRole('tab', { name: '用量' }).click();
		}
		await expect(page.getByText('暂无用量记录')).toBeVisible();
	}).toPass({ timeout: 20000 });
});

test('memory cards round-trip through the console', async ({ page }) => {
	await page.goto('/admin/ai?tab=memories');

	const dialog = page.getByRole('dialog');
	await expect(async () => {
		if (!(await dialog.isVisible())) {
			await page.getByRole('button', { name: '新建记忆卡' }).click();
		}
		await expect(dialog).toBeVisible();
	}).toPass({ timeout: 20000 });

	await dialog.getByLabel('内容').fill(MEMORY_TEXT);
	await dialog.getByRole('button', { name: '保存' }).click();

	await expect(page.getByText(MEMORY_TEXT)).toBeVisible({ timeout: 10000 });
	expect(psql(`select count(*) from ai_agent_memories where content = '${MEMORY_TEXT}'`)).toBe('1');

	const confirm = page.getByRole('alertdialog');
	await expect(async () => {
		if (!(await confirm.isVisible())) {
			await page.getByRole('button', { name: '删除' }).first().click();
		}
		await expect(confirm).toBeVisible();
	}).toPass({ timeout: 20000 });
	await confirm.getByRole('button', { name: '删除' }).click();

	await expect(page.getByText(MEMORY_TEXT)).toHaveCount(0, { timeout: 10000 });
	expect(psql(`select count(*) from ai_agent_memories where content = '${MEMORY_TEXT}'`)).toBe('0');
});
