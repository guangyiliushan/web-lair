import { expect, test } from '@playwright/test';
import { psql } from './support';

/**
 * llms.txt + Markdown mirror (M2 2d): the proposal's file lists link to clean
 * `.md` pages; both are rendered per language and the robots policy is emitted.
 */
const SLUG = 'e2e-llms-source';
const TITLE = 'E2E llms source';

test.describe.configure({ mode: 'serial', timeout: 60_000 });

test.beforeAll(() => {
	cleanup();
	const category = psql(`select id from categories limit 1`);
	psql(`insert into posts (title, slug, lang, category_id, status, content, content_format, summary, published_at)
		values ('${TITLE}', '${SLUG}', 'en', '${category}', 'published', '# Body\n\nA public body for the mirror.', 'markdown', 'A short public summary.', now())`);
});

test.afterAll(() => {
	cleanup();
});

function cleanup() {
	psql(`delete from posts where slug = '${SLUG}'`);
}

test('serves llms.txt, the .md mirror and the two AI robots groups', async ({ request }) => {
	const llms = await request.get('/en/llms.txt');
	expect(llms.status()).toBe(200);
	expect(llms.headers()['content-type']).toContain('text/markdown');
	const llmsBody = await llms.text();
	expect(llmsBody).toContain('## Posts');
	expect(llmsBody).toContain(`/en/posts/${SLUG}.md`);

	const mirror = await request.get(`/en/posts/${SLUG}.md`);
	expect(mirror.status()).toBe(200);
	expect(mirror.headers()['content-type']).toContain('text/markdown');
	const mirrorBody = await mirror.text();
	expect(mirrorBody).toContain('canonical:');
	expect(mirrorBody).toContain('A public body for the mirror.');

	const robots = await request.get('/robots.txt');
	expect(robots.status()).toBe(200);
	const robotsBody = await robots.text();
	expect(robotsBody).toContain('User-agent: GPTBot');
	expect(robotsBody).toContain('User-agent: OAI-SearchBot');
});
