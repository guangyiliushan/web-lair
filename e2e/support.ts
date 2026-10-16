import { execFileSync } from 'node:child_process';
import { expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

/**
 * Shared acceptance-test plumbing (comment P3a review follow-up): the docker
 * psql shim, the Valkey helpers and the rate-gated auth API post were copied
 * between e2e/comment-p3a.e2e.ts and e2e/admin-2fa.e2e.ts - and had already
 * drifted (the comment version grew a 429 retry the 2FA version lacked). One
 * home for both specs so they cannot drift again.
 */
export const ORIGIN = 'http://localhost:4173';

export function psql(sql: string): string {
	return execFileSync(
		'docker',
		['exec', '-i', 'web-lair-db-1', 'psql', '-U', 'root', '-d', 'local', '-tAc', sql],
		{ encoding: 'utf8' }
	).trim();
}

/**
 * Visible-only text locator (P5-5 T15): this helper had grown a sixth copy
 * inside e2e/pages-admin.e2e.ts - one home now, next to psql.
 */
export function byText(page: Page, text: string | RegExp) {
	return page.getByText(text).filter({ visible: true });
}

/**
 * Manual draft save through the editor toolbar: click and wait for the
 * "已保存" banner (the pages/refs specs carried verbatim copies that had
 * already drifted on the timeout notation; P5-5 T15).
 */
export async function manualSave(page: Page) {
	await page.getByRole('button', { name: '保存草稿' }).click({ timeout: 5000 });
	await expect(byText(page, /已保存/).first()).toBeVisible({ timeout: 60_000 });
}

/**
 * Run one valkey-cli command and return its trimmed reply (THROWS on
 * failure - for assertions and fixture setup; use valkeyDel for best-effort
 * cleanup).
 */
export function valkey(...args: string[]): string {
	return execFileSync('docker', ['exec', 'web-lair-valkey-1', 'valkey-cli', ...args], {
		encoding: 'utf8'
	}).trim();
}

/**
 * Throttle keys live in Valkey; drop them best-effort (container may be down).
 * Routes through valkey() so the docker exec wiring has exactly ONE home
 * (review finding: the three helpers each carried their own copy).
 */
export function valkeyDel(key: string) {
	try {
		valkey('DEL', key);
	} catch {
		// fail-open by contract: no Valkey means the limiter was never engaged.
	}
}

export function valkeyAlive(): boolean {
	try {
		return valkey('PING').toUpperCase() === 'PONG';
	} catch {
		return false;
	}
}

/**
 * better-auth's rate limiter is ACTIVE in the production preview and, without
 * a resolvable client IP, keys buckets by path alone: /sign-in*|/sign-up*|
 * /change-* allow 3 per rolling 10s and /two-factor/* 3 per 10s (probed: the
 * 4th rapid call answers 429 + X-Retry-After). Pace those calls with the same
 * rule, and retry once on a 429 so parallel spec files cannot flake each
 * other (shared per-path bucket).
 */
const RATE_LIMITED = /^\/(sign-in|sign-up|change-password|change-email|two-factor)\//;
const RATE_WINDOW_MS = 10_500;
const RATE_MAX = 3;
const rateGates = new Map<string, { count: number; last: number }>();

export async function apiPost(
	page: Page,
	path: string,
	data: Record<string, unknown>,
	attempt = 0
): Promise<APIResponse> {
	const apiPath = path.replace(/^\/api\/auth/, '');
	if (RATE_LIMITED.test(apiPath)) {
		const now = Date.now();
		const state = rateGates.get(apiPath) ?? { count: 0, last: 0 };
		if (now - state.last >= RATE_WINDOW_MS) {
			state.count = 0;
		} else if (state.count >= RATE_MAX) {
			// The limiter resets after a >=10s idle gap from the last request.
			await new Promise((resolve) => setTimeout(resolve, RATE_WINDOW_MS - (now - state.last)));
			state.count = 0;
		}
		state.count += 1;
		state.last = Date.now();
		rateGates.set(apiPath, state);
	}
	const response = await page.request.post(path, { data, headers: { origin: ORIGIN } });
	// Each retry waits (x-retry-after + 1)s (11s when the header is absent), so
	// callers on the default 30s test timeout should raise it (see admin-2fa).
	if (response.status() === 429 && attempt < 2) {
		const retryAfter = Number(response.headers()['x-retry-after'] ?? 11);
		await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
		return apiPost(page, path, data, attempt + 1);
	}
	return response;
}

/**
 * Open the admin sidebar user menu. The SSR trigger is clickable before
 * SvelteKit hydrates, so a first click can be swallowed under load; retry the
 * click-pair (same pattern the lang-switcher spec used inline).
 *
 * Not [data-slot="sidebar-menu-button"]: when the button doubles as a
 * DropdownMenu.Trigger its trigger props overwrite the data-slot, so target
 * the header's single button instead.
 */
export async function openAdminSidebarMenu(page: Page) {
	const trigger = page.locator('[data-slot="sidebar-header"]').getByRole('button').first();
	await expect(async () => {
		await trigger.click();
		await expect(page.locator('[role="menuitemradio"]').first()).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20000 });
}

/** Pick one language radio item inside the (already open) admin user menu. */
export async function pickLocaleMenuItem(page: Page, label: string) {
	await page.locator('[role="menuitemradio"]').filter({ hasText: label }).click();
}

/**
 * Approve one comment-queue row through the SSR bulk form, with the house
 * fresh-page retry (the notes-unlock lesson): under full-suite load the first
 * native submit can hang without a banner, and a stale click on the same page
 * eats the whole budget. Each attempt re-gotos; an attempt that finds the
 * checkbox gone treats it as already-flipped, so a late-landing POST cannot
 * double-bounce. Callers assert the resulting state in the database.
 */
export async function approveQueueRow(
	page: Page,
	commentId: string,
	options: { rowText?: string } = {}
) {
	await expect(async () => {
		await page.goto('/admin/comments');
		const checkbox = page.locator(`input[name="ids"][value="${commentId}"]`);
		if ((await checkbox.count()) === 0) return; // a previous attempt landed (row left the queue)
		if (options.rowText) {
			await expect(page.getByText(options.rowText)).toBeVisible({ timeout: 10000 });
		}
		await checkbox.check();
		await page.getByRole('button', { name: '通过' }).click({ timeout: 5000 });
		await expect(page.getByText('已通过 1 条')).toBeVisible({ timeout: 8000 });
	}).toPass({ timeout: 90_000 });
}

/**
 * Sign-up + SQL-verify + explicit sign-in (spec §1 "已验证读者"), shared by
 * the comment specs (the two local copies were verbatim - pre-release review
 * 04-F4). The password stays a caller parameter: each spec owns its fixture
 * namespace.
 */
export async function bootstrapReader(context: BrowserContext, email: string, password: string) {
	const page = await context.newPage();
	const signUp = await apiPost(page, '/api/auth/sign-up/email', {
		email,
		name: email,
		password
	});
	expect(signUp.ok()).toBeTruthy();
	psql(`update "user" set email_verified = true where email = '${email}'`);
	const signIn = await apiPost(page, '/api/auth/sign-in/email', {
		email,
		password
	});
	expect(signIn.ok()).toBeTruthy();
	await page.close();
}

/**
 * Axe gate for the content/overlay specs: zero critical violations, with the
 * impact summary logged so a serious/moderate drift stays visible. One home
 * for the filter copy (review 3d, 03 P3-7 - the two specs carried verbatim
 * copies).
 */
export async function expectNoCriticalAxe(page: Page, label: string): Promise<void> {
	// Lazy import: 27 specs import this module; only three call the gate, so
	// axe-core's parse cost stays off their workers (review 3d round 2, 01 P3-1).
	const { default: AxeBuilder } = await import('@axe-core/playwright');
	const results = await new AxeBuilder({ page }).analyze();
	const summary = results.violations.map(
		(violation) => `${violation.impact}: ${violation.id} (${violation.nodes.length})`
	);
	if (summary.length > 0) console.log(`[axe:${label}]`, summary.join(' | '));
	expect(
		results.violations.filter((violation) => violation.impact === 'critical'),
		JSON.stringify(summary)
	).toEqual([]);
}
