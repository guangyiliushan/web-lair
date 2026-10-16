import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql, valkey, valkeyAlive, valkeyDel } from './support';

/**
 * Realtime presence acceptance (platform plan §B; realtime batch R4): the
 * heartbeat -> window -> SSE chain on a fixture post — the stream header
 * contract, the window-vs-cardinality probe over a live ghost member (no
 * page-mount interference: a load-bearing rewrite after the review found
 * the old badge-based pin could not fail), the two-tabs fan-in, and the
 * refreshing-TTL probe. Fixtures are namespaced `e2e-rt` and removed in
 * teardown; the spec runs serial against the production preview and the
 * live Valkey.
 *
 * Isolation (review note): every assertion reads the fixture CONTENT key,
 * which only this spec writes — parallel workers cannot pollute it (R-2);
 * `-w1` is the house gate convention, not a requirement of this file. The
 * only shared-key write is the best-effort site-key DEL in teardown.
 */
const CATEGORY = '00000000-0000-7000-8000-0000000000e1';
const POST = '00000000-0000-7000-8000-0000000000e2';
const POST_PATH = '/zh-cn/posts/e2e-rt-post';
const GHOST_MEMBER = '0:e2e-rt-ghost';
const LIVE_MEMBER = '0:e2e-rt-live';
const CONTENT_KEY = `wl:presence:c:${POST}`;

test.use(zhCnLocale);
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(() => {
	if (!valkeyAlive()) throw new Error('Valkey container must be up for the presence spec');
	valkeyDel(CONTENT_KEY);
	psql(`delete from posts where slug like 'e2e-rt-%'`);
	psql(`delete from categories where slug = 'e2e-rt-cat'`);
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', 'E2E RT', 'e2e-rt-cat') on conflict (slug) do nothing`
	);
	psql(
		`insert into posts (id, title, slug, lang, content, category_id, status, published_at)
		 values ('${POST}', 'E2E RT 文章', 'e2e-rt-post', 'zh-cn', '正文内容', '${CATEGORY}', 'published', now() - interval '1 hour')
		 on conflict (id) do nothing`
	);
});

test.afterAll(() => {
	// The content key is fixture-scoped; the site key is cleaned for hygiene
	// (this dev Valkey is shared) and self-heals within the 60s window. The
	// date-scoped keys (presence:day:<date> / presence:max:<date>) are
	// deliberately NOT cleaned: they cannot be namespaced, deleting them
	// would wipe the dev database's real "today" numbers, and they carry a
	// 48h TTL — each run adds at most four tabs to today's counters.
	valkeyDel(CONTENT_KEY);
	valkeyDel('wl:presence:site');
	psql(`delete from posts where slug like 'e2e-rt-%'`);
	psql(`delete from categories where slug = 'e2e-rt-cat'`);
});

async function openReader(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ storageState: zhCnLocale.storageState });
	const page = await context.newPage();
	await page.goto(POST_PATH);
	return { context, page };
}

function badgeCount(page: Page) {
	return page.locator('[data-slot="presence-count"]');
}

test('the stream answers readers with the text/event-stream + no-store contract', async ({
	browser
}) => {
	const context = await browser.newContext({ storageState: zhCnLocale.storageState });
	const page = await context.newPage();
	await page.goto(POST_PATH);
	const head = await page.evaluate(async (contentId) => {
		const response = await fetch(`/api/presence/stream?c=${contentId}`);
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();
		return {
			status: response.status,
			contentType: response.headers.get('content-type'),
			cacheControl: response.headers.get('cache-control')
		};
	}, POST);
	expect(head.status).toBe(200);
	expect(head.contentType).toContain('text/event-stream');
	expect(head.cacheControl).toBe('no-store');
	await context.close();
});

test('the window read ignores an aged-out member (a raw ZCARD would say 2)', async ({
	browser
}) => {
	valkeyDel(CONTENT_KEY);
	const nowSec = Math.floor(Date.now() / 1000);
	valkey('ZADD', CONTENT_KEY, String(nowSec - 120), GHOST_MEMBER);
	valkey('ZADD', CONTENT_KEY, String(nowSec - 10), LIVE_MEMBER);
	expect(valkey('ZCARD', CONTENT_KEY)).toBe('2');

	// Probe the stream from a page that does NOT mount the content widget
	// (the home surface only beats the SITE key), so nothing can trim the
	// ghost between setup and read: the first frame must collapse the
	// window read to 1. A member-counting reader would answer 2 and fail.
	const context = await browser.newContext({ storageState: zhCnLocale.storageState });
	const page = await context.newPage();
	await page.goto('/');
	const first = await page.evaluate(async (contentId) => {
		const response = await fetch(`/api/presence/stream?c=${contentId}`);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let acc = '';
		try {
			for (let reads = 0; reads < 12; reads += 1) {
				const chunk = await reader.read();
				if (chunk.done) break;
				acc += decoder.decode(chunk.value, { stream: true });
				const line = acc.split('\n').find((row) => row.startsWith('data: '));
				if (line) return JSON.parse(line.slice('data: '.length));
			}
			return null;
		} finally {
			await reader.cancel().catch(() => {});
		}
	}, POST);
	const expectedHist = new Array<number>(20).fill(0);
	expectedHist[0] = 1;
	expect(first).toEqual({ content: { count: 1, hist: expectedHist } });
	expect(valkey('ZCARD', CONTENT_KEY)).toBe('2'); // the ghost is still on the SET
	await context.close();
});

test('two tabs on the same post fan in to two readers', async ({ browser }) => {
	valkeyDel(CONTENT_KEY);
	const first = await openReader(browser);
	await expect(badgeCount(first.page)).toHaveText('1 人正在读', { timeout: 30_000 });

	const second = await openReader(browser);
	await expect(badgeCount(second.page)).toHaveText('2 人正在读', { timeout: 30_000 });
	await expect(badgeCount(first.page)).toHaveText('2 人正在读', { timeout: 30_000 });

	await first.context.close();
	await second.context.close();
});

test('a beat refreshes the key TTL instead of leaving the short one (R-1)', async ({ browser }) => {
	valkeyDel(CONTENT_KEY);
	const { context, page } = await openReader(browser);
	await expect(badgeCount(page)).toHaveText('1 人正在读', { timeout: 30_000 });
	// Age the key's TTL hard, then wait for the next beat (≤15s away): a
	// refreshing EXPIRE restores ~48h; an NX-style expire leaves ≤90s and
	// the poll times out.
	valkey('EXPIRE', CONTENT_KEY, '90');
	await expect
		.poll(() => Number(valkey('TTL', CONTENT_KEY)), { timeout: 30_000 })
		.toBeGreaterThan(100_000);
	await context.close();
});
