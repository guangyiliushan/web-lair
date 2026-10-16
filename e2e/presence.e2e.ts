import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql, valkey, valkeyAlive, valkeyDel } from './support';

/**
 * Realtime presence acceptance (platform plan §B; realtime batch R4): the
 * heartbeat -> window -> SSE snapshot -> badge chain on a fixture post, the
 * ghost-member window pin (an aged-out member must not count - the ZCARD vs
 * ZCOUNT class), the two-tabs fan-in, and the stream's response headers.
 * Fixtures are namespaced `e2e-rt` and removed in teardown; serial chain
 * against the production preview and the live Valkey.
 */
const CATEGORY = '00000000-0000-7000-8000-0000000000e1';
const POST = '00000000-0000-7000-8000-0000000000e2';
const POST_PATH = '/zh-cn/posts/e2e-rt-post';
const GHOST_MEMBER = '0:e2e-rt-ghost';
const CONTENT_KEY = `wl:presence:c:${POST}`;

test.use(zhCnLocale);
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(() => {
	if (!valkeyAlive()) throw new Error('Valkey container must be up for the presence spec');
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
	// (this dev Valkey is shared) and self-heals within the 60s window.
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

test('one reader counts 1 over an aged-out ghost member (ZCOUNT window)', async ({ browser }) => {
	valkeyDel(CONTENT_KEY);
	const nowSec = Math.floor(Date.now() / 1000);
	valkey('ZADD', CONTENT_KEY, String(nowSec - 120), GHOST_MEMBER);
	expect(valkey('ZCARD', CONTENT_KEY)).toBe('1');

	const { context, page } = await openReader(browser);
	// The ghost stays out of the window read; a raw ZCARD would have said 2.
	await expect(badgeCount(page)).toHaveText('1 人正在读', { timeout: 30_000 });
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
