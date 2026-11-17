import { expect, test, type Locator, type Page } from '@playwright/test';
import { psql } from './support';
import { zhCnLocale } from './locale-fixture';

test.use(zhCnLocale);

/**
 * AI admin surface (AI-2) - owner flow against the real pages and database:
 * providers CRUD, the connection probe, assignments, moderation settings and
 * the memory-card round trip. The localhost origin auto-authenticates as the
 * site owner (see auth.e2e.ts / TAILSCALE_ALLOW_LOOPBACK).
 *
 * Two repo-proven hazards shape this spec: the settings shell renders its
 * children twice (mobile + desktop, one hidden by CSS), so text/CSS locators
 * are filtered to the visible one (role locators already exclude hidden
 * copies); and a click on an SSR-rendered control must retry until the state
 * actually flips, hence the toPass loops below.
 */
const PROVIDER = 'E2E Provider';
const MEMORY_TEXT = 'E2E memory card: keep the tone dry.';

/** Options wiped around the spec so each run starts from registry defaults. */
const AI_OPTION_KEYS = [
	'ai.assignments',
	'comments.moderation',
	'ai.budget',
	'ai.styleGuide',
	'ai.translation',
	'ai.pricing'
] as const;

function byText(page: Page, text: string | RegExp): Locator {
	return page.getByText(text).filter({ visible: true });
}

function vis(locator: Locator): Locator {
	return locator.filter({ visible: true });
}

// Serial suite: two sequential toPass(20s) loops in one test can exceed
// the 30s default (10-04 lesson) - keep an explicit 120s budget.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(() => {
	psql(`delete from ai_providers where name = '${PROVIDER}'`);
	psql(`delete from options where name in (${AI_OPTION_KEYS.map((key) => `'${key}'`).join(', ')})`);
	psql(`delete from ai_agent_memories where content like 'E2E memory card%'`);
});

test.afterAll(() => {
	psql(`delete from ai_providers where name = '${PROVIDER}'`);
	psql(`delete from options where name in (${AI_OPTION_KEYS.map((key) => `'${key}'`).join(', ')})`);
	psql(`delete from ai_agent_memories where content like 'E2E memory card%'`);
});

test('the settings page renders the three AI sections and the moderation / translation cards', async ({
	page
}) => {
	await page.goto('/admin/settings/ai');
	await expect(page.getByRole('button', { name: '添加服务商' })).toBeVisible({
		timeout: 10000
	});
	await expect(byText(page, '功能位分配')).toBeVisible();
	await expect(byText(page, '开关与阈值')).toBeVisible();
	await expect(byText(page, '评论分诊（审核）')).toBeVisible();
	await expect(byText(page, '自动翻译（入队门槛）')).toBeVisible();
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
	await dialog.getByLabel('密钥环境变量名').fill('AI_E2E_MISSING_KEY');
	await dialog.getByRole('button', { name: '手动添加' }).click();
	await dialog.getByPlaceholder('模型 ID，例如 gpt-4o').fill('e2e-model-a');
	await dialog.getByRole('button', { name: '添加', exact: true }).click();
	await expect(dialog.getByText('e2e-model-a')).toBeVisible();
	await dialog.getByRole('button', { name: '保存' }).click();

	await expect(byText(page, PROVIDER)).toBeVisible({ timeout: 10000 });
	expect(psql(`select count(*) from ai_providers where name = '${PROVIDER}'`)).toBe('1');

	// The connection probe reports the missing env var instead of calling out.
	await expect(async () => {
		if (!(await byText(page, /AI_E2E_MISSING_KEY 未设置/).isVisible())) {
			await page.getByRole('button', { name: '测试连接' }).click();
		}
		await expect(byText(page, /AI_E2E_MISSING_KEY 未设置/)).toBeVisible();
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

	// The model select is linked to the chosen provider: only its enabled
	// models are offered, so no free typing is needed.
	await expect(async () => {
		if (
			!(await page.locator('[data-slot="select-item"]', { hasText: 'e2e-model-a' }).isVisible())
		) {
			await form.locator('[data-slot="select-trigger"]').nth(1).click();
		}
		await expect(
			page.locator('[data-slot="select-item"]', { hasText: 'e2e-model-a' })
		).toBeVisible();
	}).toPass({ timeout: 20000 });
	await page.locator('[data-slot="select-item"]', { hasText: 'e2e-model-a' }).click();

	await expect(async () => {
		if (!(await byText(page, '功能位分配已保存').isVisible())) {
			await form.getByRole('button', { name: '保存分配' }).click();
		}
		await expect(byText(page, '功能位分配已保存')).toBeVisible();
	}).toPass({ timeout: 20000 });
	expect(
		psql(`select value->'summary'->>'provider' from options where name = 'ai.assignments'`)
	).toBe(PROVIDER);
	expect(psql(`select value->'summary'->>'model' from options where name = 'ai.assignments'`)).toBe(
		'e2e-model-a'
	);
});

test('saves the moderation switches and thresholds', async ({ page }) => {
	await page.goto('/admin/settings/ai');

	const toggle = page.getByRole('switch', { name: '启用 AI 分诊' });
	// Hydration gate (round-4 flake): force two real flips - a pre-hydration
	// click never changes aria-checked, so observing both flips proves the JS
	// is live before we fill and save (also guarantees the hidden notes-style
	// inputs exist, so a stray native POST cannot drop them).
	await expect(async () => {
		if ((await toggle.getAttribute('aria-checked')) === 'true') {
			await toggle.click();
		}
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
	}).toPass({ timeout: 20000 });
	await expect(async () => {
		if ((await toggle.getAttribute('aria-checked')) === 'false') {
			await toggle.click();
		}
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
	}).toPass({ timeout: 20000 });

	// Converge on the persisted value: a pre-hydration fill only writes the
	// DOM, so re-fill + re-save until the option row matches (round-4 flake).
	await expect(async () => {
		await vis(page.locator('#mod-link-threshold')).fill('3');
		await page.getByRole('button', { name: '保存审核设置' }).click();
		await expect(byText(page, '审核设置已保存')).toBeVisible();
		expect(
			psql(
				`select (value->>'enabled') || '|' || (value->>'linkThreshold') from options where name = 'comments.moderation'`
			)
		).toBe('true|3');
	}).toPass({ timeout: 30_000 });
});

test('saves the translation enqueue threshold', async ({ page }) => {
	await page.goto('/admin/settings/ai');

	const minChars = vis(page.locator('#translation-min-chars'));
	// Same hydration gate as the moderation card: flip the notes switch off
	// and back on; only a live component flips, which also guarantees the
	// bound hidden input is present for the save submission.
	const notesAuto = page.getByRole('switch', { name: '手记参与自动翻译' });
	await expect(async () => {
		if ((await notesAuto.getAttribute('aria-checked')) === 'true') {
			await notesAuto.click();
		}
		await expect(notesAuto).toHaveAttribute('aria-checked', 'false');
	}).toPass({ timeout: 20000 });
	await expect(async () => {
		if ((await notesAuto.getAttribute('aria-checked')) === 'false') {
			await notesAuto.click();
		}
		await expect(notesAuto).toHaveAttribute('aria-checked', 'true');
	}).toPass({ timeout: 20000 });
	// Converge on the persisted value: keep re-filling and re-saving until
	// the option row matches (pre-hydration fills are DOM-only).
	await expect(async () => {
		await minChars.fill('450');
		await page.getByRole('button', { name: '保存翻译设置' }).click();
		await expect(byText(page, '翻译设置已保存')).toBeVisible();
		expect(
			psql(
				`select (value->>'minChars') || '|' || (value->>'notesAuto') from options where name = 'ai.translation'`
			)
		).toBe('450|true');
	}).toPass({ timeout: 30_000 });
});

/**
 * Price rows: the table is edited one row per `<provider>/<model>` key, so a
 * typo in a key or a field name cannot silently unprice a model (an unpriced
 * call is indistinguishable from "never configured" and quietly disables the
 * budget). These three cases pin the round-trip, the responsive layout and the
 * preview-before-write contract.
 */
test('adds a price as a row, then edits it, stamping the provenance', async ({ page }) => {
	psql(`delete from options where name = 'ai.pricing'`);

	await page.goto('/admin/settings/ai');
	const card = vis(page.locator('form[action="?/savePricing"]')).first();
	await expect(card).toBeVisible({ timeout: 10000 });

	// An empty table says so instead of showing an empty box.
	await expect(byText(page, '还没有价格')).toBeVisible();

	// Add: the model is picked from the configured keys (never typed), so a
	// typo cannot create a key no call will ever match.
	const add = card.getByRole('button', { name: '添加价格' });
	await expect(async () => {
		await add.click();
		await expect(card.locator('select')).toHaveCount(1);
	}).toPass({ timeout: 20_000 });
	await card.locator('select').selectOption('E2E Provider/e2e-model-a');
	await expect(card.getByLabel('e2e-model-a · 输入 / 1M')).toBeVisible();

	// Converge on the persisted value: a pre-hydration fill is DOM-only.
	await expect(async () => {
		await card.getByLabel('e2e-model-a · 输入 / 1M').fill('1.5');
		await card.getByLabel('e2e-model-a · 输出 / 1M').fill('2');
		await card.getByRole('button', { name: '保存成本表' }).click();
		await expect(byText(page, '成本表已保存')).toBeVisible();
		expect(
			psql(
				`select value->'E2E Provider/e2e-model-a'->>'inputPer1M' from options where name = 'ai.pricing'`
			)
		).toBe('1.5');
	}).toPass({ timeout: 30_000 });

	// A hand-entered price is hand-pinned, and the badge says so.
	expect(
		psql(
			`select value->'E2E Provider/e2e-model-a'->>'source' from options where name = 'ai.pricing'`
		)
	).toBe('manual');
	await expect(card.getByText('手动').first()).toBeVisible();
	expect(
		psql(
			`select value->'E2E Provider/e2e-model-a'->>'outputPer1M' from options where name = 'ai.pricing'`
		)
	).toBe('2');
});

test('price rows stack into labelled cards without horizontal overflow', async ({ page }) => {
	psql(`delete from options where name = 'ai.pricing'`);
	psql(
		`insert into options (name, value) values ('ai.pricing', '{"E2E Provider/e2e-model-a": {"inputPer1M": 1}}'::jsonb)`
	);
	await page.goto('/admin/settings/ai');
	const card = vis(page.locator('form[action="?/savePricing"]')).first();
	await expect(card).toBeVisible({ timeout: 10000 });
	const table = card.locator('table').first();

	// Wide: a real table (header row + cells), the copy stays 822px there.
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(table).toHaveCSS('display', 'table');

	// Narrow: the same table becomes stacked rows, and each price cell carries
	// its own label because the header row is no longer rendered.
	await page.setViewportSize({ width: 560, height: 900 });
	await expect(table).toHaveCSS('display', 'block');
	await expect(card.locator('[data-pricing-label="inputPer1M"]').first()).toBeVisible();
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
	).toBeLessThanOrEqual(0);

	await page.setViewportSize({ width: 1280, height: 900 });
});

test('previews the catalog sync and writes nothing on cancel', async ({ page }) => {
	const seed = '{"E2E Provider/e2e-model-a": {"inputPer1M": 1}}';
	psql(`delete from options where name = 'ai.pricing'`);
	psql(`insert into options (name, value) values ('ai.pricing', '${seed}'::jsonb)`);

	await page.goto('/admin/settings/ai');
	const card = vis(page.locator('form[action="?/previewPricingSync"]')).first();
	await expect(card).toBeVisible({ timeout: 10000 });
	await card.getByRole('button', { name: '从 models.dev 同步' }).click();

	// models.dev is a live third-party document: when it is unreachable the
	// action answers 502 and the banner explains it. There is nothing to
	// preview then, so the case is skipped rather than made flaky.
	const dialog = page.getByRole('alertdialog');
	const unavailable = byText(page, '无法获取 models.dev 价格表，未做任何修改。');
	await expect(dialog.or(unavailable)).toBeVisible({ timeout: 60_000 });
	if (await unavailable.isVisible()) test.skip(true, 'models.dev unreachable');

	await expect(dialog).toContainText('从 models.dev 同步价格？');
	await expect(dialog).toContainText('与目录不一致');
	await dialog.getByRole('button', { name: '取消' }).click();
	await expect(dialog).toBeHidden();

	// Cancel is not an apply: the hand-pinned value survives untouched.
	expect(
		psql(
			`select value->'E2E Provider/e2e-model-a'->>'inputPer1M' from options where name = 'ai.pricing'`
		)
	).toBe('1');
});

test('the AI console lands on the activity ledger', async ({ page }) => {
	await page.goto('/admin/ai');

	// No tab bar and no chat shell: the page opens on the ledger itself, and
	// the only way out of an observation surface is into configuration.
	await expect(byText(page, 'AI 使用').first()).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('link', { name: '设置', exact: true })).toBeVisible();

	// The readiness line is on the page whether or not anything has run, and
	// slots with a configuration but no caller say so instead of showing green.
	await expect(byText(page, '就绪').first()).toBeVisible();
	await expect(byText(page, '尚未接入').first()).toBeVisible();

	// The conversation shell is gone, not merely disabled.
	await expect(page.getByText('还没有对话')).toHaveCount(0);
});

test('memory cards round-trip through AI settings', async ({ page }) => {
	await page.goto('/admin/settings/ai');

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

	// Scoped: the settings page also has delete buttons on provider rows, and
	// clicking one of those would tear down the provider this suite just made.
	const confirm = page.getByRole('alertdialog');
	await expect(async () => {
		if (!(await confirm.isVisible())) {
			await page.getByTestId('memory-card-delete').click();
		}
		await expect(confirm).toBeVisible();
	}).toPass({ timeout: 20000 });
	await confirm.getByRole('button', { name: '删除' }).click();

	await expect(page.getByText(MEMORY_TEXT)).toHaveCount(0, { timeout: 10000 });
	expect(psql(`select count(*) from ai_agent_memories where content = '${MEMORY_TEXT}'`)).toBe('0');
});
