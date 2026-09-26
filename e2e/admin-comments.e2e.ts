import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

/**
 * Comment review queue (B2) - owner flow against the real page and the real
 * database. The queue is fed through the docker container the rest of the
 * local toolchain uses (the app has no comment-creation UI yet); fixture rows
 * are namespaced and removed in teardown.
 *
 * The localhost origin auto-authenticates as the site owner (see auth.e2e.ts /
 * TAILSCALE_ALLOW_LOOPBACK in the playwright webServer env).
 *
 * P1 note: business ids are uuid now (uuidv7), so the fixtures use fixed
 * well-formed uuids instead of the old text ids.
 */
const CATEGORY = '00000000-0000-7000-8000-000000000010';
const POST = '00000000-0000-7000-8000-000000000011';
const ACTIVE = '00000000-0000-7000-8000-000000000001';
const EXTRA = '00000000-0000-7000-8000-000000000002';

function psql(sql: string): string {
	return execFileSync(
		'docker',
		['exec', '-i', 'web-lair-db-1', 'psql', '-U', 'root', '-d', 'local', '-tAc', sql],
		{ encoding: 'utf8' }
	).trim();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
	psql(`delete from comments where id in ('${ACTIVE}', '${EXTRA}')`);
	// Clean by natural keys as well: posts now carry unique(lang, slug), so a
	// leftover row with the same slug would collide on insert (P1.1 review).
	psql(`delete from posts where slug = 'e2e-review-post'`);
	psql(`delete from categories where slug = 'e2e-review-cat'`);
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', 'E2E', 'e2e-review-cat') on conflict (slug) do nothing`
	);
	psql(
		`insert into posts (id, title, slug, content_format, category_id, status) values ('${POST}', 'E2E post', 'e2e-review-post', 'markdown', '${CATEGORY}', 'published') on conflict (id) do nothing`
	);
	psql(
		`insert into comments (id, post_id, author, text, state) values ('${ACTIVE}', '${POST}', 'E2E', 'pending item from e2e', 'pending'), ('${EXTRA}', '${POST}', 'E2E', 'second pending item', 'pending')`
	);
});

test.afterAll(() => {
	psql(`delete from comments where id in ('${ACTIVE}', '${EXTRA}')`);
	psql(`delete from posts where id = '${POST}'`);
	psql(`delete from categories where id = '${CATEGORY}'`);
});

test('the owner approves a pending comment from the queue', async ({ page }) => {
	await page.goto('/admin/comments');
	await expect(page.getByText('pending item from e2e')).toBeVisible({ timeout: 10000 });

	await page.locator(`input[name="ids"][value="${ACTIVE}"]`).check();
	await page.getByRole('button', { name: '通过' }).click();

	await expect(page.getByText('已通过 1 条')).toBeVisible();
	expect(psql(`select state from comments where id = '${ACTIVE}'`)).toBe('approved');
});

test('the decided comment left the pending queue and shows under its tab', async ({ page }) => {
	await page.goto('/admin/comments');
	await expect(page.getByText('pending item from e2e')).toHaveCount(0);
	// the untouched sibling is still pending
	await expect(page.getByText('second pending item')).toBeVisible();

	await page.goto('/admin/comments?state=approved');
	await expect(page.getByText('pending item from e2e')).toBeVisible();
});
