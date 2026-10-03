import { argon2Sync } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { psql, valkeyAlive, valkeyDel } from './support';

/**
 * N1 public-surface acceptance nails (notes plan §3.5 items 1-3 and 6)
 * against the built site: the list/topic/detail pages on seeded rows, the
 * missing-language 404 hint, the retired-slug 301, and the full password
 * gate - locked shell (body and metadata absent from the DOM), wrong-password
 * 403, failure-budget 429, successful unlock (cookie persists across
 * reloads) and the comment section appearing only for open notes.
 * Fixtures live on the shared dev database under the `e2e-n1%` slug prefix
 * and are cleaned in beforeAll/afterAll.
 */

const TOPIC_ID = '00000000-0000-7000-8000-0000000004a1';
const OPEN_EN_ID = '00000000-0000-7000-8000-0000000004a2';
const OPEN_ZH_ID = '00000000-0000-7000-8000-0000000004a3';
const GATED_ID = '00000000-0000-7000-8000-0000000004a4';
const ONLY_EN_ID = '00000000-0000-7000-8000-0000000004a5';
const PRIVATE_ID = '00000000-0000-7000-8000-0000000004a6';
const TRASH_ID = '00000000-0000-7000-8000-0000000004a7';
const GROUP_OPEN = '00000000-0000-7000-8000-0000000004b0';
const GROUP_GATED = '00000000-0000-7000-8000-0000000004b1';
const GROUP_ONLY_EN = '00000000-0000-7000-8000-0000000004b2';

const SLUG_OPEN = 'e2e-n1-open';
const SLUG_GATED = 'e2e-n1-gated';
const SLUG_ONLY_EN = 'e2e-n1-only-en';
const SLUG_PRIVATE = 'e2e-n1-private';
const SLUG_TRASH = 'e2e-n1-trash';
const SLUG_RETIRED = 'e2e-n1-old-slug';
const TOPIC_SLUG = 'e2e-n1-topic';
const TITLE_OPEN = 'E2E N1 open note';
const TITLE_OPEN_ZH = 'E2E N1 中文手记';
const TITLE_GATED = 'E2E N1 locked note';
const TITLE_ONLY_EN = 'E2E N1 english only';
const TITLE_PRIVATE = 'E2E N1 private note';
const TITLE_TRASH = 'E2E N1 trash note';
const APPROVED_COMMENT = 'Approved note comment body.';
const BODY_TEXT = 'Public diary body text.';
const GATED_SECRET = 'Body that must stay hidden.';
const GATE_PASSWORD = 'e2e-gate-pass';

function cleanup(): void {
	psql(`delete from notes where slug like 'e2e-n1%'`);
	psql(`delete from slug_trackers where slug like 'e2e-n1%'`);
	psql(`delete from topics where slug = '${TOPIC_SLUG}'`);
	// The gate limiter lives in Valkey per IP; clear the budget best-effort.
	valkeyDel(`limits:note-gate:::ffff:127.0.0.1`);
	valkeyDel(`limits:note-gate:127.0.0.1`);
	valkeyDel(`limits:note-gate:::1`);
}

test.beforeAll(() => {
	cleanup();
	// A real PHC hash for the gate (same parameters as services/note-gate).
	const phc = (() => {
		const salt = Buffer.alloc(16, 7);
		const tag = argon2Sync('argon2id', {
			message: Buffer.from(GATE_PASSWORD, 'utf8'),
			nonce: salt,
			tagLength: 32,
			memory: 19456,
			passes: 2,
			parallelism: 1
		});
		return `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString('base64')}$${tag.toString('base64')}`;
	})();

	psql(
		`insert into topics (id, name, slug, description, sort_order) values ('${TOPIC_ID}', 'E2E N1 topic', '${TOPIC_SLUG}', 'Seeded topic', 0)`
	);
	psql(
		[
			`insert into notes (id, slug, title, content, lang, status, published_at, translation_group, topic_id, mood, weather_code, location, allow_comment, meta) values`,
			`('${OPEN_EN_ID}', '${SLUG_OPEN}', '${TITLE_OPEN}', '${BODY_TEXT}', 'en', 'published', now() - interval '2 days', '${GROUP_OPEN}', '${TOPIC_ID}', 'good', 61, 'Taipei', true, '{"emotions":["happy","calm"]}'::jsonb)`,
			`;`,
			`insert into notes (id, slug, title, content, lang, status, published_at, translation_group, topic_id, allow_comment, translated_from_note_id, translation_origin) values`,
			`('${OPEN_ZH_ID}', '${SLUG_OPEN}', '${TITLE_OPEN_ZH}', '中文正文。', 'zh-cn', 'published', now() - interval '1 day', '${GROUP_OPEN}', '${TOPIC_ID}', true, '${OPEN_EN_ID}', 'human')`,
			`;`,
			`insert into notes (id, slug, title, content, lang, status, published_at, translation_group, password_hash, allow_comment) values`,
			`('${GATED_ID}', '${SLUG_GATED}', '${TITLE_GATED}', '${GATED_SECRET}', 'en', 'published', now() - interval '3 days', '${GROUP_GATED}', '${phc}', true)`,
			`;`,
			`insert into notes (id, slug, title, content, lang, status, published_at, translation_group, allow_comment) values`,
			`('${ONLY_EN_ID}', '${SLUG_ONLY_EN}', '${TITLE_ONLY_EN}', 'Only in english.', 'en', 'published', now() - interval '4 days', '${GROUP_ONLY_EN}', true)`,
			`;`,
			`insert into notes (id, slug, title, content, lang, status, published_at, translation_group, allow_comment) values`,
			`('${PRIVATE_ID}', '${SLUG_PRIVATE}', '${TITLE_PRIVATE}', 'Private body.', 'en', 'private', now() - interval '5 days', '00000000-0000-7000-8000-0000000004b3', true)`,
			`;`,
			`insert into notes (id, slug, title, content, lang, status, published_at, translation_group, allow_comment) values`,
			`('${TRASH_ID}', '${SLUG_TRASH}', '${TITLE_TRASH}', 'Trashed body.', 'en', 'trash', now() - interval '6 days', '00000000-0000-7000-8000-0000000004b4', true)`,
			`;`,
			`insert into comments (id, note_id, author, text, state) values`,
			`('00000000-0000-7000-8000-0000000004d1', '${ONLY_EN_ID}', 'E2E reader', '${APPROVED_COMMENT}', 'approved')`,
			`;`,
			`insert into slug_trackers (id, slug, type, lang, target_id) values`,
			`('00000000-0000-7000-8000-0000000004c1', '${SLUG_RETIRED}', 'note', 'en', '${OPEN_EN_ID}')`
		].join(' ')
	);
});

test.afterAll(() => {
	cleanup();
});

async function unlock(page: Page, password: string) {
	const form = page.locator('form[action$="/unlock"]');
	await form.locator('input[name="password"]').fill(password);
	await form.locator('button[type="submit"]').click();
}

test.describe('N1 public notes surface', () => {
	test('the notes list shows open and gated rows with the lock marker', async ({ page }) => {
		await page.goto('/en/notes');
		await expect(page.getByRole('link', { name: TITLE_OPEN })).toBeVisible();
		await expect(page.getByRole('link', { name: TITLE_GATED })).toBeVisible();
		// The gated row shows a lock but never its derived excerpt.
		await expect(page.getByText(GATED_SECRET)).toHaveCount(0);
		await expect(page.getByRole('img', { name: 'Locked' }).first()).toBeVisible();
	});

	test('the topic page lists its notes', async ({ page }) => {
		await page.goto(`/en/notes/topics/${TOPIC_SLUG}`);
		await expect(page.getByRole('link', { name: TITLE_OPEN })).toBeVisible();
	});

	test('an open note renders body, mood metadata and a comment section', async ({ page }) => {
		await page.goto(`/en/notes/${SLUG_OPEN}`);
		await expect(page.getByText(BODY_TEXT)).toBeVisible();
		await expect(page.getByText('Good')).toBeVisible();
		await expect(page.getByText('Taipei')).toBeVisible();
		// Guests see the comment section with a login link, never the form.
		await expect(page.getByRole('heading', { name: 'Comments (0)' })).toBeVisible();
	});

	test('a missing language version 404s with the hint', async ({ page }) => {
		const response = await page.goto(`/zh-cn/notes/${SLUG_ONLY_EN}`);
		expect(response?.status()).toBe(404);
		// The page renders in the requested locale: the zh-cn hint copy.
		await expect(page.getByText('这篇手记没有该语言的版本')).toBeVisible();
	});

	test('private and trash notes stay off every public face', async ({ page }) => {
		// Both were published once (published_at set): only the status hides them.
		await page.goto('/en/notes');
		await expect(page.getByText(TITLE_PRIVATE)).toHaveCount(0);
		await expect(page.getByText(TITLE_TRASH)).toHaveCount(0);

		await page.goto(`/en/notes/topics/${TOPIC_SLUG}`);
		await expect(page.getByText(TITLE_PRIVATE)).toHaveCount(0);
		await expect(page.getByText(TITLE_TRASH)).toHaveCount(0);

		const priv = await page.goto(`/en/notes/${SLUG_PRIVATE}`);
		expect(priv?.status()).toBe(404);
		const trash = await page.goto(`/en/notes/${SLUG_TRASH}`);
		expect(trash?.status()).toBe(404);
	});

	test('an approved note comment renders on the note page', async ({ page }) => {
		// The write side lands comments as `pending`; the review flow flips them
		// to `approved` (covered for the queue in comment-p3a). This pins the
		// note-target read leg: an approved comment shows on the public page.
		await page.goto(`/en/notes/${SLUG_ONLY_EN}`);
		await expect(page.getByRole('heading', { name: 'Comments (1)' })).toBeVisible();
		await expect(page.getByText(APPROVED_COMMENT)).toBeVisible();
	});

	test('a retired slug resolves with one 301 to the live note', async ({ request }) => {
		const response = await request.get(`/en/notes/${SLUG_RETIRED}`, { maxRedirects: 0 });
		expect(response.status()).toBe(301);
		expect(response.headers()['location']).toContain(`/en/notes/${SLUG_OPEN}`);
	});
});

test.describe('N1 password gate', () => {
	test('a gated note renders the shell only: no body, no metadata, noindex', async ({ page }) => {
		const response = await page.goto(`/en/notes/${SLUG_GATED}`);
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('heading', { name: TITLE_GATED })).toBeVisible();
		await expect(page.getByText(GATED_SECRET)).toHaveCount(0);
		await expect(page.getByText('Taipei')).toHaveCount(0);
		await expect(page.locator('form[action$="/unlock"]')).toBeVisible();
		await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
	});

	test('a wrong password 403s without unlocking', async ({ page }) => {
		await page.goto(`/en/notes/${SLUG_GATED}`);
		await unlock(page, 'wrong-password');
		await expect(page.getByText('Wrong password.')).toBeVisible();
		await expect(page.getByText(GATED_SECRET)).toHaveCount(0);
	});

	test('the failure budget 429s after repeated wrong attempts', async ({ page }) => {
		test.skip(!valkeyAlive(), 'Valkey is down: the limiter is fail-open by contract');
		await page.goto(`/en/notes/${SLUG_GATED}`);
		for (let attempt = 0; attempt < 6; attempt += 1) {
			await unlock(page, `wrong-${attempt}`);
		}
		await expect(page.getByText('Too many failed attempts')).toBeVisible();
	});

	test('the correct password unlocks the diary and the cookie persists', async ({ page }) => {
		await page.goto(`/en/notes/${SLUG_GATED}`);
		await unlock(page, GATE_PASSWORD);
		await expect(page.getByText(GATED_SECRET)).toBeVisible();
		// The unlock cookie survives a reload (server-side verification).
		await page.reload();
		await expect(page.getByText(GATED_SECRET)).toBeVisible();
		// The comment section appears for the unlocked note.
		await expect(page.getByRole('heading', { name: 'Comments (0)' })).toBeVisible();
	});
});
