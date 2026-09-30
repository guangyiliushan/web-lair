import { execFileSync } from 'node:child_process';
import { expect, test, type Browser, type Page, type Response } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';

/**
 * Comment P3a acceptance (pages plan T7): guest guidance, submit -> pending,
 * approved-only reading surface, two-level render, pin/owner badges, owner
 * auto-approve, the throttle window and the queue's post/note target display.
 * Runs against the production preview, the live database and the Valkey
 * limiter; fixture rows are namespaced `e2e-cmt` and removed in teardown.
 * Reader accounts are created through the sign-up API (better-auth hashes the
 * password, SQL cannot).
 */
const ORIGIN = 'http://localhost:4173';
const CATEGORY = '00000000-0000-7000-8000-0000000000c1';
const POST = '00000000-0000-7000-8000-0000000000c2';
const NOTE = '00000000-0000-7000-8000-0000000000c3';
const C_APPROVED = '00000000-0000-7000-8000-0000000000d1';
const C_REPLY = '00000000-0000-7000-8000-0000000000d2';
const C_PENDING = '00000000-0000-7000-8000-0000000000d3';
const C_REJECTED = '00000000-0000-7000-8000-0000000000d4';
const C_NOTE = '00000000-0000-7000-8000-0000000000d5';

const POST_PATH = '/zh-cn/posts/e2e-cmt-post';
const READER_EMAIL = 'e2e-cmt-reader@example.com';
const THROTTLE_EMAIL = 'e2e-cmt-throttle@example.com';
const READER_PASSWORD = 'e2e-cmt-password-1';

const T_APPROVED = 'e2e-cmt 已通过的根评论';
const T_REPLY = 'e2e-cmt 已通过的回复';
const T_PENDING = 'e2e-cmt 待审中的评论';
const T_REJECTED = 'e2e-cmt 被拒绝的评论';
const T_NOTE = 'e2e-cmt 笔记目标评论';
const T_READER = 'e2e-cmt 读者提交的评论';
const T_OWNER = 'e2e-cmt 站长的新评论';
const T_RL1 = 'e2e-cmt 节流一';
const T_RL2 = 'e2e-cmt 节流二';
const T_RL3 = 'e2e-cmt 节流三';

test.use(zhCnLocale);
test.describe.configure({ mode: 'serial' });

function psql(sql: string): string {
	return execFileSync(
		'docker',
		['exec', '-i', 'web-lair-db-1', 'psql', '-U', 'root', '-d', 'local', '-tAc', sql],
		{ encoding: 'utf8' }
	).trim();
}

/** Throttle keys live in Valkey; drop them best-effort (container may be down). */
function valkeyDel(key: string) {
	try {
		execFileSync('docker', ['exec', 'web-lair-valkey-1', 'valkey-cli', 'DEL', key], {
			encoding: 'utf8'
		});
	} catch {
		// fail-open by contract: no Valkey means the limiter was never engaged.
	}
}

test.beforeAll(() => {
	psql(`delete from comments where text like 'e2e-cmt%'`);
	psql(`delete from comments where post_id = '${POST}' or note_id = '${NOTE}'`);
	psql(`delete from posts where slug like 'e2e-cmt-%'`);
	psql(`delete from notes where slug like 'e2e-cmt-%'`);
	psql(`delete from categories where slug = 'e2e-cmt-cat'`);
	psql(`delete from "user" where email in ('${READER_EMAIL}', '${THROTTLE_EMAIL}')`);
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', 'E2E 评论', 'e2e-cmt-cat') on conflict (slug) do nothing`
	);
	psql(
		`insert into posts (id, title, slug, lang, content, category_id, status, published_at)
		 values ('${POST}', 'E2E 评论文章', 'e2e-cmt-post', 'zh-cn', '正文内容', '${CATEGORY}', 'published', now() - interval '1 hour')
		 on conflict (id) do nothing`
	);
	psql(
		`insert into notes (id, lang, title, slug, status, published_at, content)
		 values ('${NOTE}', 'zh-cn', 'E2E 评论笔记', 'e2e-cmt-note', 'published', now() - interval '1 hour', '笔记正文')
		 on conflict (id) do nothing`
	);
	psql(
		`insert into comments (id, post_id, author, text, state, pin, is_owner_reply)
		 values ('${C_APPROVED}', '${POST}', 'E2E Owner', '${T_APPROVED}', 'approved', true, true)`
	);
	psql(
		`insert into comments (id, post_id, author, text, state, parent_comment_id, root_comment_id)
		 values ('${C_REPLY}', '${POST}', '读者乙', '${T_REPLY}', 'approved', '${C_APPROVED}', '${C_APPROVED}')`
	);
	psql(
		`insert into comments (id, post_id, author, text, state)
		 values ('${C_PENDING}', '${POST}', '待审者', '${T_PENDING}', 'pending'),
		        ('${C_REJECTED}', '${POST}', '被拒者', '${T_REJECTED}', 'rejected')`
	);
	psql(
		`insert into comments (id, note_id, author, text, state)
		 values ('${C_NOTE}', '${NOTE}', '笔记评论者', '${T_NOTE}', 'pending')`
	);
});

test.afterAll(() => {
	for (const email of [THROTTLE_EMAIL, READER_EMAIL]) {
		const uid = psql(`select id from "user" where email = '${email}'`);
		if (uid) valkeyDel(`wl:limits:comment:${uid}`);
	}
	psql(`delete from comments where text like 'e2e-cmt%'`);
	psql(`delete from comments where post_id = '${POST}' or note_id = '${NOTE}'`);
	psql(`delete from posts where slug like 'e2e-cmt-%'`);
	psql(`delete from notes where slug like 'e2e-cmt-%'`);
	psql(`delete from categories where slug = 'e2e-cmt-cat'`);
	psql(`delete from "user" where email in ('${READER_EMAIL}', '${THROTTLE_EMAIL}')`);
});

/* ── auth fixtures ──────────────────────────────────────────────────────── */

/**
 * better-auth's rate limiter is active in the production preview and keys
 * buckets by path: /sign-in*|/sign-up* allow 3 per rolling 10s. Pace calls and
 * retry once on 429 so parallel spec files cannot flake each other.
 */
const RATE_LIMITED = /^\/(sign-in|sign-up|change-password|change-email|two-factor)\//;
const RATE_WINDOW_MS = 10_500;
const RATE_MAX = 3;
const rateGates = new Map<string, { count: number; last: number }>();

async function apiPost(
	page: Page,
	path: string,
	data: Record<string, unknown>,
	attempt = 0
): Promise<Response> {
	const apiPath = path.replace(/^\/api\/auth/, '');
	if (RATE_LIMITED.test(apiPath)) {
		const now = Date.now();
		const state = rateGates.get(apiPath) ?? { count: 0, last: 0 };
		if (now - state.last >= RATE_WINDOW_MS) {
			state.count = 0;
		} else if (state.count >= RATE_MAX) {
			await new Promise((resolve) => setTimeout(resolve, RATE_WINDOW_MS - (now - state.last)));
			state.count = 0;
		}
		state.count += 1;
		state.last = Date.now();
		rateGates.set(apiPath, state);
	}
	const response = await page.request.post(path, { data, headers: { origin: ORIGIN } });
	if (response.status() === 429 && attempt < 2) {
		const retryAfter = Number(response.headers()['x-retry-after'] ?? 11);
		await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
		return apiPost(page, path, data, attempt + 1);
	}
	return response;
}

/** Sign-up + SQL-verify + explicit sign-in (spec §1 "已验证读者"). */
async function createReader(browser: Browser, email: string) {
	const context = await browser.newContext({ storageState: zhCnLocale.storageState });
	const page = await context.newPage();
	const signUp = await apiPost(page, '/api/auth/sign-up/email', {
		email,
		name: email,
		password: READER_PASSWORD
	});
	expect(signUp.ok()).toBeTruthy();
	psql(`update "user" set email_verified = true where email = '${email}'`);
	const signIn = await apiPost(page, '/api/auth/sign-in/email', {
		email,
		password: READER_PASSWORD
	});
	expect(signIn.ok()).toBeTruthy();
	return { context, page };
}

async function guestContext(browser: Browser) {
	return browser.newContext({ storageState: zhCnLocale.storageState });
}

/* ── T7 acceptance ──────────────────────────────────────────────────────── */

test('guest: approved only, two-level render, pin/owner badges, login prompt', async ({ page }) => {
	await page.goto(POST_PATH);
	await expect(page.locator('#comments-title')).toContainText('(2)');
	await expect(page.getByText(T_APPROVED)).toBeVisible();
	// The reply renders nested inside its root (two-level thread).
	const approvedItem = page.locator(`[data-comment-id="${C_APPROVED}"]`);
	await expect(approvedItem.getByText(T_REPLY)).toBeVisible();
	await expect(approvedItem.getByText('置顶')).toBeVisible();
	await expect(approvedItem.getByText('站长', { exact: true })).toBeVisible();
	await expect(page.getByText(T_PENDING)).toHaveCount(0);
	await expect(page.getByText(T_REJECTED)).toHaveCount(0);
	await expect(page.getByText('登录后参与讨论。')).toBeVisible();
	await expect(page.locator('#comments').getByRole('link', { name: '登录' })).toBeVisible();
	await expect(page.locator('#comments textarea')).toHaveCount(0);
});

test('reader submits -> pending with the own-pending badge; guests do not see it', async ({
	browser
}) => {
	const { context, page } = await createReader(browser, READER_EMAIL);
	await page.goto(POST_PATH);
	const textarea = page.getByRole('textbox', { name: '写下你的想法…' });
	await expect(textarea).toBeVisible();
	await textarea.fill(T_READER);
	await page.getByRole('button', { name: '发表' }).click();
	await expect(page.getByText('已提交，待审核。')).toBeVisible();

	const ownItem = page.locator('[data-comment-id]').filter({ hasText: T_READER });
	await expect(ownItem.getByText('审核中')).toBeVisible();
	expect(psql(`select state from comments where text = '${T_READER}'`)).toBe('pending');

	const guest = await guestContext(browser);
	const guestPage = await guest.newPage();
	await guestPage.goto(POST_PATH);
	await expect(guestPage.getByText(T_READER)).toHaveCount(0);
	await guest.close();
	await context.close();
});

test('owner approves from the queue (post target) and the guest now sees it', async ({
	browser
}) => {
	const owner = await guestContext(browser);
	const ownerPage = await owner.newPage();
	await ownerPage.goto('/admin/comments');
	// Reaching the queue also proves the loopback owner session; the row shows
	// the resolved post target (comment P3a queue enhancement).
	const row = ownerPage.locator('label').filter({ hasText: T_READER });
	await expect(row).toBeVisible({ timeout: 15000 });
	await expect(row.getByText('博文')).toBeVisible();
	await expect(row.getByText('E2E 评论文章')).toBeVisible();

	const commentId = psql(`select id from comments where text = '${T_READER}'`);
	await ownerPage.locator(`input[name="ids"][value="${commentId}"]`).check();
	await ownerPage.getByRole('button', { name: '通过' }).click();
	await expect(ownerPage.getByText('已通过 1 条')).toBeVisible();
	expect(psql(`select state from comments where id = '${commentId}'`)).toBe('approved');

	const guest = await guestContext(browser);
	const guestPage = await guest.newPage();
	await guestPage.goto(POST_PATH);
	await expect(guestPage.getByText(T_READER)).toBeVisible();
	await guest.close();
	await owner.close();
});

test('the owners own comment auto-approves and is public immediately', async ({ browser }) => {
	const owner = await guestContext(browser);
	const ownerPage = await owner.newPage();
	// Visiting /admin first acquires the loopback owner session for this context.
	await ownerPage.goto('/admin/comments');
	await expect(ownerPage.getByRole('tab', { name: /待审/ })).toBeVisible({ timeout: 15000 });

	await ownerPage.goto(POST_PATH);
	await ownerPage.getByRole('textbox', { name: '写下你的想法…' }).fill(T_OWNER);
	await ownerPage.getByRole('button', { name: '发表' }).click();
	await expect(ownerPage.getByText('已发表。')).toBeVisible();
	expect(psql(`select state from comments where text = '${T_OWNER}'`)).toBe('approved');

	const guest = await guestContext(browser);
	const guestPage = await guest.newPage();
	await guestPage.goto(POST_PATH);
	const item = guestPage.locator('[data-comment-id]').filter({ hasText: T_OWNER });
	await expect(item.getByText('站长', { exact: true })).toBeVisible();
	await expect(item.getByText('审核中')).toHaveCount(0);
	await guest.close();
	await owner.close();
});

test('throttle: two submissions pass, the third is refused inside the window', async ({
	browser
}) => {
	const { context, page } = await createReader(browser, THROTTLE_EMAIL);
	await page.goto(POST_PATH);
	const textarea = page.getByRole('textbox', { name: '写下你的想法…' });

	await textarea.fill(T_RL1);
	await page.getByRole('button', { name: '发表' }).click();
	// The own pending row appearing is the completion signal (the flash alone
	// can be left over from a previous submit).
	await expect(page.getByText(T_RL1)).toBeVisible();

	await textarea.fill(T_RL2);
	await page.getByRole('button', { name: '发表' }).click();
	await expect(page.getByText(T_RL2)).toBeVisible();

	// The prior update() resets the form; make sure this fill survived before
	// submitting - a wiped textarea would be stopped by `required` client-side
	// and nothing would reach the server.
	await textarea.fill(T_RL3);
	await expect(textarea).toHaveValue(T_RL3);
	await page.getByRole('button', { name: '发表' }).click();
	await expect(page.getByText('发言太快了，请一分钟后再试。')).toBeVisible();

	expect(
		psql(
			`select count(*) from comments c join "user" u on u.id = c.reader_id where u.email = '${THROTTLE_EMAIL}'`
		)
	).toBe('2');
	await context.close();
});

test('the queue resolves the note target (the item absorbed from N1)', async ({ browser }) => {
	const owner = await guestContext(browser);
	const ownerPage = await owner.newPage();
	await ownerPage.goto('/admin/comments');
	const row = ownerPage.locator('label').filter({ hasText: T_NOTE });
	await expect(row).toBeVisible({ timeout: 15000 });
	await expect(row.getByText('笔记', { exact: true })).toBeVisible();
	await expect(row.getByText('E2E 评论笔记')).toBeVisible();
	await owner.close();
});
