import { expect, test, type Page } from '@playwright/test';
import { psql, valkeyDel } from './support';
import { zhCnLocale } from './locale-fixture';

/**
 * Public friends page (M3 / links plan 5.1-5.2): the three zones against the
 * real database, the application form's soft pass (pending + precheck
 * evidence), the auditable hard gates, de-duplication, the honeypot and the
 * `friends.apply.enabled` switch. `/admin/friends` is covered by its own M1
 * spec and is not exercised here.
 *
 * Fixtures are namespaced `e2e-friends-`; option rows that the spec overrides
 * (`friends.apply`, `friends.policy`, `site.info`) are captured and restored
 * so a live developer database keeps its settings.
 */
const PREFIX = 'e2e-friends-';
const IDS = {
	alpha: '00000000-0000-7000-8000-000000000201',
	delta: '00000000-0000-7000-8000-000000000202',
	epsilon: '00000000-0000-7000-8000-000000000203'
};
const APPLICANT = 'https://e2e-friends-applicant.test';
const BLOCKED = 'https://e2e-friends-blocked.github.io';

const saved: Record<string, string> = {};

test.use(zhCnLocale);
test.describe.configure({ mode: 'serial', timeout: 180_000 });

function cleanup() {
	psql(`delete from links where name like '${PREFIX}%'`);
}

function setOption(name: string, json: string) {
	psql(
		`insert into options (name, value) values ('${name}', $j$${json}$j$::jsonb)
		 on conflict (name) do update set value = excluded.value`
	);
}

function restoreOption(name: string) {
	const value = saved[name];
	if (!value) {
		psql(`delete from options where name = '${name}'`);
		return;
	}
	setOption(name, value);
}

function clearApplyLimit() {
	// The cache store prefixes every key with `wl:` (CACHE_PREFIX), and
	// `getClientAddress()` on the preview's IPv6 loopback is `::1`.
	for (const address of ['::1', '127.0.0.1', 'unknown']) {
		valkeyDel(`wl:limits:friends:apply:${address}`);
	}
}

function dbValue(sql: string): string {
	return psql(sql);
}

async function openApply(page: Page) {
	await page.getByRole('button', { name: '申请友链' }).click();
	return page.getByRole('dialog');
}

test.beforeAll(() => {
	for (const name of ['friends.apply', 'friends.policy', 'site.info', 'friends.checks']) {
		saved[name] = psql(`select coalesce(value::text, '') from options where name = '${name}'`);
	}
	cleanup();
	// Force the two switches the spec depends on; the values mirror the
	// registry defaults (plan 2.6) so the page renders its documented shape.
	setOption('friends.apply', '{"enabled":true,"allowSubPath":false}');
	setOption(
		'friends.policy',
		'{"blockedHostSuffixes":["github.io"],"blockedTlds":[".tk"],"acceptedBacklinkHosts":[],"publicBannedList":true}'
	);
	setOption(
		'friends.checks',
		'{"enabled":true,"cadenceHours":24,"failStreak":3,"backlinkStreak":2,"graceDays":30,"timeoutMs":10000,"concurrency":2}'
	);
	// The policy may only promise scheduled work; seed both rows (idempotent)
	// and remember their flags so a developer DB is left as it was.
	for (const job of ['links.check', 'links.prune']) {
		saved[`schedule:${job}`] = psql(
			`select coalesce((select is_enabled::text from job_schedules where job = '${job}' limit 1), '')`
		);
	}
	psql(`insert into job_schedules (job, cron_expr, tz)
		select 'links.check', '0 5 * * *', 'UTC'
		where not exists (select 1 from job_schedules where job = 'links.check')`);
	psql(`insert into job_schedules (job, cron_expr, tz)
		select 'links.prune', '30 5 * * *', 'UTC'
		where not exists (select 1 from job_schedules where job = 'links.prune')`);
	psql(`update job_schedules set is_enabled = true where job in ('links.check', 'links.prune')`);
	psql(`insert into links
		(id, name, url, host, avatar, description, backlink_url, status, reason, lost_since, sort_order, reviewed_at, check_enabled)
		values
		('${IDS.alpha}', '${PREFIX}alpha', 'https://alpha.e2e-friends.test', 'alpha.e2e-friends.test',
			null, 'alpha description', 'https://alpha.e2e-friends.test/links', 'approved', null, null, 1, now(), true),
		('${IDS.delta}', '${PREFIX}delta', 'https://delta.e2e-friends.test', 'delta.e2e-friends.test',
			null, 'delta description', 'https://delta.e2e-friends.test/links', 'outdated', null, now() - interval '2 days', 2, null, true),
		('${IDS.epsilon}', '${PREFIX}epsilon', 'https://epsilon.e2e-friends.test', 'epsilon.e2e-friends.test',
			null, null, null, 'banned', 'e2e public ban reason', null, 3, now(), false)`);
});

test.afterAll(() => {
	cleanup();
	for (const name of ['friends.apply', 'friends.policy', 'site.info', 'friends.checks']) {
		restoreOption(name);
	}
	for (const job of ['links.check', 'links.prune']) {
		const savedFlag = saved[`schedule:${job}`];
		if (savedFlag === '') {
			psql(`delete from job_schedules where job = '${job}'`);
		} else {
			psql(`update job_schedules set is_enabled = ${savedFlag === 'true'} where job = '${job}'`);
		}
	}
});

test('renders the approved zone as links and the outdated/banned zones unlinked', async ({
	page
}) => {
	await page.goto('/zh-cn/friends');
	await expect(page.getByRole('heading', { level: 1, name: '友链', exact: true })).toBeVisible({
		timeout: 20_000
	});

	const alpha = page.getByRole('link', { name: new RegExp(`${PREFIX}alpha`) });
	await expect(alpha).toBeVisible();
	await expect(alpha).toHaveAttribute('href', 'https://alpha.e2e-friends.test');
	await expect(alpha).toHaveAttribute('target', '_blank');
	await expect(alpha).toHaveAttribute('rel', /noopener/);

	await expect(page.getByRole('heading', { name: '无法访问的网站' })).toBeVisible();
	await expect(page.getByText(`${PREFIX}delta`)).toBeVisible();
	await expect(page.getByRole('link', { name: new RegExp(`${PREFIX}delta`) })).toHaveCount(0);

	await expect(page.getByRole('heading', { name: '不符合要求的网站' })).toBeVisible();
	await expect(page.getByText(`${PREFIX}epsilon`)).toBeVisible();
	await expect(page.getByText('理由：e2e public ban reason')).toBeVisible();
	await expect(page.getByRole('link', { name: new RegExp(`${PREFIX}epsilon`) })).toHaveCount(0);
});

test('renders the site.info block from the option', async ({ page }) => {
	const expectedName = dbValue(
		`select coalesce(value->>'name', 'Web Lair') from options where name = 'site.info'`
	);
	await page.goto('/zh-cn/friends');
	await expect(page.getByRole('heading', { name: '本站友链信息' })).toBeVisible();
	await expect(page.getByText(expectedName || 'Web Lair')).toBeVisible();
	await expect(page.getByText('http://localhost:4173/')).toBeVisible();
});

test('hard gate: a free-host application is refused and stored as rejected', async ({ page }) => {
	cleanup();
	clearApplyLimit();
	await page.goto('/zh-cn/friends');
	const dialog = await openApply(page);
	await dialog.getByLabel('站点名称').fill(`${PREFIX}blocked`);
	await dialog.getByLabel('站点地址').fill(BLOCKED);
	await dialog.getByLabel('回链页面 URL').fill(`${BLOCKED}/links`);
	await dialog.getByLabel('邮箱').fill('blocked@example.com');
	await dialog.getByRole('checkbox').click();
	await dialog.getByRole('button', { name: '提交申请' }).click();

	await expect(dialog.getByRole('alert')).toHaveText('不接受免费托管域名，请使用你自己的域名。');
	expect(dbValue(`select status from links where name = '${PREFIX}blocked'`)).toBe('rejected');
	expect(dbValue(`select reason from links where name = '${PREFIX}blocked'`)).toContain(
		'auto: blocked-host (github.io)'
	);
});

test('soft pass: a reachable-looking application lands pending with precheck evidence', async ({
	page
}) => {
	clearApplyLimit();
	await page.goto('/zh-cn/friends');
	const dialog = await openApply(page);
	await dialog.getByLabel('站点名称').fill(`${PREFIX}applicant`);
	await dialog.getByLabel('站点地址').fill(APPLICANT);
	await dialog.getByLabel('回链页面 URL').fill(`${APPLICANT}/links`);
	await dialog.getByLabel('邮箱').fill('applicant@example.com');
	await dialog.getByLabel('简短介绍').fill('e2e application');
	await dialog.getByRole('checkbox').click();
	await dialog.getByRole('button', { name: '提交申请' }).click();

	await expect(dialog.getByRole('status')).toHaveText(
		'已收到。通过后会直接显示在本页，不另行通知。'
	);
	expect(dbValue(`select status from links where name = '${PREFIX}applicant'`)).toBe('pending');
	// Evidence moved to the dedicated run table (L4): the checker ring is no
	// longer touched by the application flow.
	expect(
		dbValue(`select count(*)::int from link_prechecks
			where link_id = (select id from links where name = '${PREFIX}applicant')
			and trigger = 'application' and status = 'completed'`)
	).toBe('1');
	expect(dbValue(`select recent_checks::text from links where name = '${PREFIX}applicant'`)).toBe(
		''
	);
});

test('duplicate domain is refused while the first row is pending', async ({ page }) => {
	clearApplyLimit();
	await page.goto('/zh-cn/friends');
	const dialog = await openApply(page);
	await dialog.getByLabel('站点名称').fill(`${PREFIX}duplicate`);
	await dialog.getByLabel('站点地址').fill(APPLICANT);
	await dialog.getByLabel('回链页面 URL').fill(`${APPLICANT}/links`);
	await dialog.getByLabel('邮箱').fill('duplicate@example.com');
	await dialog.getByRole('checkbox').click();
	await dialog.getByRole('button', { name: '提交申请' }).click();

	await expect(dialog.getByRole('alert')).toHaveText('该站点已在列表中或正在等待审核。');
	expect(dbValue(`select count(*) from links where host = 'e2e-friends-applicant.test'`)).toBe('1');
});

test('an approved application appears on the public wall', async ({ page }) => {
	// The soft-pass test left `${PREFIX}applicant` pending with no verified
	// backlink, so the admin approve path needs the override note (M1 guard).
	await page.goto('/admin/friends?state=pending');
	const row = page.getByRole('row').filter({ hasText: `${PREFIX}applicant` });
	await row.getByRole('button', { name: '通过' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('备注').fill('e2e approved');
	await dialog.getByRole('button', { name: '确定' }).click();
	await expect
		.poll(() => psql(`select status from links where name = '${PREFIX}applicant'`), {
			timeout: 15_000
		})
		.toBe('approved');

	await page.goto('/zh-cn/friends');
	await expect(page.getByRole('link', { name: new RegExp(`${PREFIX}applicant`) })).toHaveAttribute(
		'href',
		APPLICANT
	);
});

test('honeypot submissions report success without writing a row', async ({ page }) => {
	clearApplyLimit();
	await page.goto('/zh-cn/friends');
	const dialog = await openApply(page);
	await dialog.getByLabel('站点名称').fill(`${PREFIX}honeypot`);
	await dialog.getByLabel('站点地址').fill('https://e2e-friends-honeypot.test');
	await dialog.getByLabel('回链页面 URL').fill('https://e2e-friends-honeypot.test/links');
	await dialog.getByLabel('邮箱').fill('bot@example.com');
	await dialog.getByRole('checkbox').click();
	await dialog.locator('input[name="website"]').evaluate((element) => {
		(element as HTMLInputElement).value = 'bot';
	});
	await dialog.getByRole('button', { name: '提交申请' }).click();

	await expect(dialog.getByRole('status')).toHaveText(
		'已收到。通过后会直接显示在本页，不另行通知。'
	);
	expect(dbValue(`select count(*) from links where name = '${PREFIX}honeypot'`)).toBe('0');
});

test('the application form lives in a dialog, not in the page flow', async ({ page }) => {
	await page.goto('/zh-cn/friends');
	await expect(page.locator('input[name="name"]')).toHaveCount(0);
	const dialog = await openApply(page);
	await expect(dialog.getByRole('heading', { name: '想交换友链吗？' })).toBeVisible();
	await expect(dialog.locator('input[name="name"]')).toBeVisible();
});

test('?apply=1 opens the dialog and Escape closes it', async ({ page }) => {
	await page.goto('/zh-cn/friends?apply=1');
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
});

test('the public page keeps the policy behind a link and shows it in an overlay', async ({
	page
}) => {
	await page.goto('/zh-cn/friends');
	// The full text is not in the page flow any more: the section that used to
	// hold it is gone, and the summary block is the only in-page anchor.
	await expect(page.locator('section#friends-policy')).toHaveCount(0);
	const trigger = page.getByRole('button', { name: '阅读《友链规则》全文' });
	await expect(trigger).toBeVisible();
	await trigger.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('heading', { name: '友链规则全文' })).toBeVisible();
	// Only the shadcn default close control: a second one is a duplicate.
	await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(1);
	await expect(dialog.getByText(/连续 3 次/)).toBeVisible();
	await expect(dialog.getByText(/30 天/)).toBeVisible();
	await dialog.getByText('查看当前不接受的主机/后缀').click();
	await expect(dialog.getByText('github.io')).toBeVisible();
	await expect(dialog.getByText(/系统直接拒绝/)).toBeVisible();
	await expect(dialog.getByText(/90 天/)).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the policy stops promising automatic deletion without a prune schedule', async ({ page }) => {
	psql(`update job_schedules set is_enabled = false where job = 'links.prune'`);
	try {
		await page.goto('/zh-cn/friends');
		await page.getByRole('button', { name: '阅读《友链规则》全文' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText(/清理任务从列表中删除/)).toHaveCount(0);
		await expect(dialog.getByText(/连续 3 次/)).toBeVisible();
	} finally {
		psql(`update job_schedules set is_enabled = true where job = 'links.prune'`);
	}
});

test('the apply dialog links to the same policy overlay', async ({ page }) => {
	await page.goto('/zh-cn/friends');
	const applyDialog = await openApply(page);
	await applyDialog.getByRole('button', { name: '阅读《友链规则》全文' }).click();
	const policy = page.getByRole('dialog').filter({ hasText: '友链规则全文' });
	await expect(policy).toBeVisible();
	await expect(policy.getByRole('button', { name: 'Close' })).toHaveCount(1);
	await expect(policy.getByText(/30 天/)).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(policy).toHaveCount(0);
	// The application form survives closing the policy overlay.
	await expect(applyDialog.getByRole('button', { name: '提交申请' })).toBeVisible();
});

test('no horizontal overflow at mobile and desktop widths', async ({ page }) => {
	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 768, height: 1024 },
		{ width: 1024, height: 768 },
		{ width: 1440, height: 900 }
	]) {
		await page.setViewportSize(viewport);
		await page.goto('/zh-cn/friends');
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
			.toBe(true);
	}
});

test('friends.apply.enabled=false hides the form and shows the closed copy', async ({ page }) => {
	setOption('friends.apply', '{"enabled":false,"allowSubPath":false}');
	await page.goto('/zh-cn/friends');
	await expect(page.getByText('申请暂时关闭。')).toBeVisible();
	await expect(page.getByRole('button', { name: '申请友链' })).toHaveCount(0);
	await expect(page.locator('input[name="name"]')).toHaveCount(0);
});
