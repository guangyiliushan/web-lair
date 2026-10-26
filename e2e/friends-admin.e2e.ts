import { expect, test } from '@playwright/test';
import { psql } from './support';
import { zhCnLocale } from './locale-fixture';

/**
 * Friends console (links L3) - owner flow against the real page and the real
 * database. Fixtures are namespaced (`e2e-friend-`) and removed in teardown.
 *
 * The localhost origin auto-authenticates as the site owner (see auth.e2e.ts /
 * TAILSCALE_ALLOW_LOOPBACK in the playwright webServer env). The spec never
 * triggers a network check: `checkOne`/`checkAll` would reach the internet and
 * need a running drain, so the review matrix and the purge path (both purely
 * local) are what gets exercised here.
 */
const PREFIX = 'e2e-friend-';
const IDS = {
	alpha: '00000000-0000-7000-8000-000000000101',
	beta: '00000000-0000-7000-8000-000000000102',
	gamma: '00000000-0000-7000-8000-000000000103',
	delta: '00000000-0000-7000-8000-000000000104',
	epsilon: '00000000-0000-7000-8000-000000000105',
	zeta: '00000000-0000-7000-8000-000000000106'
};

test.use(zhCnLocale);
test.describe.configure({ mode: 'serial' });

function cleanup() {
	psql(`delete from links where name like '${PREFIX}%'`);
}

test.beforeAll(() => {
	cleanup();
	// CHECK 4 (lost_since <-> outdated), CHECK 2 (banned needs a reason) and
	// CHECK 5 (live rows need backlink_url) all shape the fixture.
	psql(`insert into links
		(id, name, url, host, backlink_url, status, reason, lost_since, check_enabled, backlink_ok, last_checked_at)
		values
		('${IDS.alpha}', 'e2e-friend-alpha', 'https://alpha.e2e-friend.test', 'alpha.e2e-friend.test',
			'https://alpha.e2e-friend.test/links', 'approved', null, null, true, true, now()),
		('${IDS.beta}', 'e2e-friend-beta', 'https://beta.e2e-friend.test', 'beta.e2e-friend.test',
			'https://beta.e2e-friend.test/links', 'approved', null, null, true, null, null),
		('${IDS.gamma}', 'e2e-friend-gamma', 'https://gamma.e2e-friend.test', 'gamma.e2e-friend.test',
			'https://gamma.e2e-friend.test/links', 'pending', null, null, true, null, null),
		('${IDS.delta}', 'e2e-friend-delta', 'https://delta.e2e-friend.test', 'delta.e2e-friend.test',
			'https://delta.e2e-friend.test/links', 'outdated', null, now() - interval '2 days', true, false, null),
		('${IDS.epsilon}', 'e2e-friend-epsilon', 'https://epsilon.e2e-friend.test', 'epsilon.e2e-friend.test',
			null, 'banned', 'e2e ban reason', null, false, null, null),
		('${IDS.zeta}', 'e2e-friend-zeta', 'https://zeta.e2e-friend.test', 'zeta.e2e-friend.test',
			null, 'rejected', 'e2e reject reason', null, true, null, null)`);
});

test.afterAll(cleanup);

test('the default tab lists approved rows and counts are real', async ({ page }) => {
	await page.goto('/admin/friends');
	await expect(page.getByText('e2e-friend-alpha')).toBeVisible();
	await expect(page.getByText('e2e-friend-beta')).toBeVisible();
	// The pending tab advertises the one pending fixture (no mock numbers).
	// The state filter is a shadcn ToggleGroup (single-select -> role=radio).
	await expect(page.getByRole('radio', { name: /待审核/ })).toContainText('1');
});

test('the state filter cannot be deselected by re-clicking the active item', async ({ page }) => {
	await page.goto('/admin/friends?state=pending');
	const active = page.getByRole('radio', { name: /待审核/ });
	await expect(active).toHaveAttribute('data-state', 'on');
	// bits-ui's single-select toggle clears its value on a second click; a
	// filter always has a state, so the group has to snap straight back.
	await active.click();
	await expect(active).toHaveAttribute('data-state', 'on');
	await expect(page).toHaveURL(/[?&]state=pending/);
	await expect(page.getByText('e2e-friend-gamma')).toBeVisible();
});

test('approving a pending row without a verified backlink needs an override note', async ({
	page
}) => {
	await page.goto('/admin/friends?state=pending');
	await page.getByRole('button', { name: '通过' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	// The guard is server-side; the dialog only mirrors it by disabling submit.
	await expect(dialog.getByRole('button', { name: '确定' })).toBeDisabled();
	await dialog.getByLabel('备注').fill('checked by hand');
	await dialog.getByRole('button', { name: '确定' }).click();
	await expect
		.poll(() => psql(`select status from links where id = '${IDS.gamma}'`), { timeout: 15_000 })
		.toBe('approved');
	await expect
		.poll(() => psql(`select reason from links where id = '${IDS.gamma}'`))
		.toBe('override: checked by hand');
});

test('a manual create lands as approved', async ({ page }) => {
	await page.goto('/admin/friends');
	await page.getByRole('button', { name: '新建' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('名字').fill('e2e-friend-created');
	await dialog.getByLabel('网址').fill('https://created.e2e-friend.test');
	await dialog.getByLabel('回链页面').fill('https://created.e2e-friend.test/links');
	await dialog.getByRole('button', { name: '确定' }).click();
	await expect
		.poll(() => psql(`select status from links where name = 'e2e-friend-created'`), {
			timeout: 15_000
		})
		.toBe('approved');
});

test('purging the outdated tab deletes only outdated rows', async ({ page }) => {
	await page.goto('/admin/friends?state=outdated');
	await page.getByRole('button', { name: '清除全部失联' }).first().click();
	const alert = page.getByRole('alertdialog');
	await expect(alert).toBeVisible();
	await alert.getByRole('button', { name: '清除全部失联' }).click();
	await expect
		.poll(() => psql(`select count(*)::int from links where status = 'outdated'`), {
			timeout: 15_000
		})
		.toBe('0');
	// The banned row is the public blacklist and must survive a bulk purge.
	expect(psql(`select count(*)::int from links where id = '${IDS.epsilon}'`)).toBe('1');
});

test('the detail sheet renders the evidence ring', async ({ page }) => {
	await page.goto('/admin/friends?state=rejected');
	const row = page.getByRole('row').filter({ hasText: 'e2e-friend-zeta' });
	await row.getByRole('button', { name: '详情' }).click();
	const sheet = page.getByRole('dialog');
	await expect(sheet.getByText('基本信息')).toBeVisible();
	await expect(sheet.getByText('e2e reject reason')).toBeVisible();
});
