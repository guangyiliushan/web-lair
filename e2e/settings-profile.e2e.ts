import { expect, test, type Page } from '@playwright/test';
import { expectNoCriticalAxe, psql } from './support';

/**
 * W4 acceptance arc on the isolated `local_e2e` database only. The spec
 * refuses to run against any other database because it writes the owner
 * profile/home hero/content language and therefore must never touch `dev`.
 *
 * Covered: profile save -> reload -> header + homepage reflection; 1-6
 * grapheme header labels (latin/CJK/emoji) and the full-name fallback; hero
 * per-locale edit, copy-default, effective preview and clear-to-fallback; the
 * single social rail (hero/nav/mobile, RSS once); content language in Profile
 * and gone from Account; no fake online/status ticket and no `#content` dead
 * anchor; the header container tiers at 1024/1280/1440/1920 and narrow widths;
 * critical axe violations on the edited surfaces.
 */
test.describe.configure({ mode: 'serial', timeout: 60_000 });

let insertedPointer = false;

const OWNER = 'select id from "user" where role = \'owner\' order by id limit 1';

function assertLocalE2e(): void {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('W4 e2e requires DATABASE_URL pointing at local_e2e');
	const name = new URL(url).pathname.replace(/^\//, '');
	if (name !== 'local_e2e') {
		throw new Error(`W4 e2e refuses to write ${name}; use DATABASE_URL=...local_e2e`);
	}
}

function ownerId(): string {
	const id = psql(OWNER);
	if (!id) throw new Error('local_e2e has no owner user');
	return id;
}

function resetOwner(displayName = 'guangyiliushan'): void {
	const id = ownerId();
	psql(
		`update user_profiles set display_name = '${displayName}', header_label = null, avatar_url = null, links = null where user_id = '${id}'`
	);
	psql(`update "user" set default_lang = null where id = '${id}'`);
	psql('delete from home_hero');
}

test.beforeAll(() => {
	assertLocalE2e();
	const id = ownerId();
	// The W3/W0 scratch DB can carry the owner user without the pointer row.
	// Profile editing needs the pointer (owner-only guard), so seed it here.
	if (!psql('select owner_user_id from site_identity where id = 1')) {
		psql(`insert into site_identity (id, owner_user_id) values (1, '${id}')`);
		insertedPointer = true;
	}
	resetOwner();
});

test.afterAll(() => {
	// Leave the shared scratch DB in a deterministic seed-like state.
	resetOwner('Admin');
	if (insertedPointer) psql('delete from site_identity where id = 1');
});

function profileSection(page: Page, heading: string) {
	return page.locator('section').filter({
		has: page.getByRole('heading', { name: heading, exact: true })
	});
}

async function saveSection(page: Page, heading: string, expected: string) {
	const section = profileSection(page, heading);
	// Profile identity + social share one SettingsForm; hero and content
	// language each own a form nested INSIDE their section. Resolve both.
	const direct = section.locator('form');
	const form = (await direct.count())
		? direct
		: page.locator('form').filter({ has: page.getByRole('heading', { name: heading }) });
	const [response] = await Promise.all([
		page.waitForResponse(
			(request) =>
				request.request().method() === 'POST' && request.url().includes('/admin/settings/profile')
		),
		form.getByRole('button', { name: 'Save', exact: true }).click()
	]);
	// Enhanced action results are HTTP 200 even for `fail()`; the rendered
	// status/alert text is the truth.
	void response;
	await expect(form.locator('[role="status"], [role="alert"]').first()).toContainText(expected);
}

async function gotoProfile(page: Page): Promise<void> {
	const response = await page.goto('/admin/settings/profile');
	expect(response?.status()).toBe(200);
	await expect(
		page.getByRole('heading', { name: 'Profile & Preferences', exact: true })
	).toBeVisible();
	// The production preview is SSR + hydration: an early native click hits
	// the markup before Svelte attaches the handler. Settle the network and
	// let the add-row helper retry once if hydration was still in flight.
	await page.waitForLoadState('networkidle');
}

/** Add a social row; retries the click if hydration swallowed the first one. */
async function addSocialRow(social: ReturnType<typeof profileSection>): Promise<void> {
	const button = social.getByRole('button', { name: 'Add link' });
	const selects = social.locator('select[name="linkPlatform"]');
	const before = await selects.count();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await button.click();
		try {
			await expect(selects).toHaveCount(before + 1, { timeout: 2500 });
			return;
		} catch {
			// hydration race: click again
		}
	}
	throw new Error('Add link did not add a social row');
}

async function setProfile(
	page: Page,
	values: { displayName: string; headerLabel?: string; avatarUrl?: string }
): Promise<void> {
	await gotoProfile(page);
	await page.locator('input[name="displayName"]').fill(values.displayName);
	await page.locator('input[name="headerLabel"]').fill(values.headerLabel ?? '');
	await page.locator('input[name="avatarUrl"]').fill(values.avatarUrl ?? '');
	await saveSection(page, 'Public identity', 'Profile saved.');
}

async function socialHrefs(page: Page, rail: string): Promise<string[]> {
	return page
		.locator(`[data-slot="social-rail-${rail}"] a`)
		.evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
}

test('profile saves and drives the header + homepage hero', async ({ page }) => {
	await gotoProfile(page);
	await page.locator('input[name="displayName"]').fill('mikoto');
	await page.locator('input[name="headerLabel"]').fill('shan');
	await page.locator('input[name="avatarUrl"]').fill('https://example.com/avatar.png');

	const social = profileSection(page, 'Social links');
	await addSocialRow(social);
	await social.locator('select[name="linkPlatform"]').selectOption('github');
	await social.locator('input[name="linkHref"]').fill('https://github.com/mikoto');
	await addSocialRow(social);
	await social.locator('select[name="linkPlatform"]').nth(1).selectOption('email');
	await social.locator('input[name="linkHref"]').nth(1).fill('mailto:mikoto@example.com');
	await saveSection(page, 'Social links', 'Profile saved.');

	await page.reload();
	await expect(page.locator('input[name="displayName"]')).toHaveValue('mikoto');
	await expect(page.locator('input[name="headerLabel"]')).toHaveValue('shan');
	await expect(page.locator('input[name="avatarUrl"]')).toHaveValue(
		'https://example.com/avatar.png'
	);
	await expect(page.locator('input[name="linkHref"]').nth(0)).toHaveValue(
		'https://github.com/mikoto'
	);
	await expect(page.locator('input[name="linkHref"]').nth(1)).toHaveValue(
		'mailto:mikoto@example.com'
	);

	// Homepage: the parameterized default title follows the new full name; the
	// header shows the compact label with the full name in aria/title, and the
	// same two social links + the fixed RSS item render once in the hero rail.
	await page.goto('/');
	const brand = page.locator('header [data-slot="site-header-bar"] a[title]').first();
	await expect(brand).toHaveAttribute('aria-label', 'mikoto');
	await expect(brand).toHaveAttribute('title', 'mikoto');
	await expect(brand).toContainText('shan');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText("Hi, I'm mikoto 👋");

	const heroHrefs = await socialHrefs(page, 'hero');
	expect(heroHrefs.slice(0, 2)).toEqual(['https://github.com/mikoto', 'mailto:mikoto@example.com']);
	expect(heroHrefs[2]).toMatch(/\/rss\.xml$/);
	await expect(page.locator('[data-slot="social-rail-hero"] a[href$="/rss.xml"]')).toHaveCount(1);

	// Nav panel uses the exact same owner source and order.
	const desktopNav = page.locator('nav[aria-label="Main navigation"]');
	await desktopNav.getByRole('link', { name: 'Home', exact: true }).hover();
	await expect(page.locator('[data-slot="nav-menu-panel"]').first()).toBeVisible();
	expect(await socialHrefs(page, 'nav')).toEqual(await socialHrefs(page, 'hero'));

	// Mobile menu consumes the same rail (one owner source).
	await page.setViewportSize({ width: 800, height: 900 });
	await page.getByRole('button', { name: 'Open menu' }).click();
	await expect(page.locator('[data-slot="social-rail-mobile"]')).toBeVisible();
	expect(await socialHrefs(page, 'mobile')).toEqual(await socialHrefs(page, 'hero'));
});

test('header_label enforces 1-6 graphemes and the empty fallback', async ({ page }) => {
	await gotoProfile(page);
	await page.locator('input[name="headerLabel"]').fill('abcdefg');
	await saveSection(page, 'Public identity', '1-6 characters');

	const sixEmoji = '👨‍👩‍👧‍👦'.repeat(6);
	await page.locator('input[name="headerLabel"]').fill(sixEmoji);
	await saveSection(page, 'Public identity', 'Profile saved.');
	await page.reload();
	await expect(page.locator('input[name="headerLabel"]')).toHaveValue(sixEmoji);
	expect(
		psql(`select char_length(header_label) from user_profiles where user_id = '${ownerId()}'`)
	).toBe(String([...sixEmoji].length));

	// Clear => empty is stored as NULL and the header falls back to the full
	// name (Q6).
	await page.getByRole('button', { name: 'Clear', exact: true }).click();
	await saveSection(page, 'Public identity', 'Profile saved.');
	await page.reload();
	await expect(page.locator('input[name="headerLabel"]')).toHaveValue('');
	await page.goto('/');
	const brand = page.locator('header [data-slot="site-header-bar"] a[title]').first();
	await expect(brand).toHaveAttribute('title', 'mikoto');
	await expect(brand).toContainText('mikoto');
});

test('hero editor: locale tab, copy default, effective preview, clear fallback', async ({
	page
}) => {
	await gotoProfile(page);
	const hero = profileSection(page, 'Home hero');
	await expect(hero.getByRole('button', { name: 'English' })).toBeVisible();
	await expect(hero.getByRole('button', { name: '简体中文' })).toBeVisible();

	await hero.getByRole('button', { name: 'Copy default copy' }).click();
	await expect(hero.locator('input[name="hero.title.en"]')).toHaveValue("Hi, I'm mikoto 👋");
	await saveSection(page, 'Home hero', 'Home hero saved.');

	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText("Hi, I'm mikoto 👋");

	await gotoProfile(page);
	await page.locator('input[name="hero.title.en"]').fill('Hello {name}');
	await expect(
		profileSection(page, 'Home hero').locator('[data-slot="hero-effective"]').first()
	).toContainText('locale override');
	await saveSection(page, 'Home hero', 'Home hero saved.');

	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello mikoto');

	// Emptying the override returns to the built-in parameterized title and
	// never renders a blank hero.
	await gotoProfile(page);
	await page.locator('input[name="hero.title.en"]').fill('');
	await expect(
		profileSection(page, 'Home hero').locator('[data-slot="hero-effective"]').first()
	).toContainText('built-in copy');
	await saveSection(page, 'Home hero', 'Home hero saved.');
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText("Hi, I'm mikoto 👋");

	// No revisions table: empty maps fall back instead of forking history.
	expect(
		psql(
			"select count(*) from information_schema.tables where table_schema='public' and table_name='home_hero_revisions'"
		)
	).toBe('0');
});

test('content language lives in Profile, not Account', async ({ page }) => {
	await gotoProfile(page);
	const section = profileSection(page, 'Content language');
	await section.locator('select[name="lang"]').selectOption('ja');
	await saveSection(page, 'Content language', 'Content language saved');
	await page.reload();
	await expect(profileSection(page, 'Content language').locator('select[name="lang"]')).toHaveValue(
		'ja'
	);
	expect(psql(`select default_lang from "user" where id = '${ownerId()}'`)).toBe('ja');

	await page.goto('/admin/settings/account');
	await expect(page.getByRole('heading', { name: 'Content language', exact: true })).toHaveCount(0);
	await expect(page.locator('select[name="lang"]')).toHaveCount(0);
});

test('no fake online, no status ticket, no #content dead anchor', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('[data-slot="owner-status-trigger"]')).toHaveCount(0);
	await expect(page.locator('#content')).toHaveCount(0);
	await expect(page.locator('a[href="#content"]')).toHaveCount(0);

	const desktopNav = page.locator('nav[aria-label="Main navigation"]');
	await desktopNav.getByRole('link', { name: 'Home', exact: true }).hover();
	await expect(page.locator('[data-slot="nav-menu-panel"]').first()).toBeVisible();
	await expect(page.locator('[data-slot="nav-menu-panel"] [role="img"]')).toHaveCount(0);
});

test('header tiers hold at 1024/1280/1440/1920 and narrow widths', async ({ page }) => {
	await setProfile(page, { displayName: 'guangyiliushan', headerLabel: 'guang' });
	await page.goto('/');

	const nav = page.locator('nav[aria-label="Main navigation"]');
	const brand = page.locator('header [data-slot="site-header-bar"] a[title]').first();
	const bar = page.locator('[data-slot="site-header-bar"]');
	const mobileButton = page.getByRole('button', { name: 'Open menu' });

	for (const width of [1920, 1440, 1280, 1024]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(nav, `nav @${width}`).toBeVisible();
		await expect(mobileButton, `mobile button @${width}`).toBeHidden();
		await expect(brand).toBeVisible();
		const barBox = await bar.boundingBox();
		const navBox = await nav.boundingBox();
		expect(barBox).not.toBeNull();
		expect(navBox).not.toBeNull();
		expect(barBox!.x).toBeGreaterThanOrEqual(0);
		expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(width);
		// Brand and nav never overlap: the brand stays min-w-0/truncate.
		expect(navBox!.x).toBeGreaterThanOrEqual(barBox!.x);
	}

	await page.setViewportSize({ width: 900, height: 900 });
	await expect(nav).toBeHidden();
	await expect(mobileButton).toBeVisible();

	await page.setViewportSize({ width: 340, height: 800 });
	await expect(mobileButton).toBeVisible();
	await expect(brand.locator('[data-slot="site-brand-name"]')).toBeHidden(); // avatar-only stage
});

test('critical axe violations are zero on profile and homepage', async ({ page }) => {
	await gotoProfile(page);
	await expectNoCriticalAxe(page, 'settings-profile');
	await page.goto('/');
	await expectNoCriticalAxe(page, 'homepage');
});
