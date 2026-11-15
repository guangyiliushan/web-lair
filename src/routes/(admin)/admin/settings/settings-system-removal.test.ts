import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * W10.3 acceptance: the System section is deleted, not parked (decision
 * register §3J). Its four fields had zero consumers, so nothing should bring
 * the route, the nav entry, the mock labels or the option names back. The
 * real system surfaces live in /admin/maintenance, /admin/files and
 * /api/health.
 */
const LAYOUT = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');
const OPTIONS = readFileSync(
	new URL('../../../../lib/server/config/options-registry.ts', import.meta.url),
	'utf8'
);
const LOCALES = ['en', 'ja', 'zh-cn'];
const PAGES = [
	'profile',
	'site',
	'content',
	'notifications',
	'integrations',
	'storage',
	'ai',
	'account'
];
const PAGES_SOURCE = [
	...PAGES.flatMap((id) => [
		new URL(`./${id}/+page.svelte`, import.meta.url),
		new URL(`./${id}/+page.server.ts`, import.meta.url)
	]),
	// The index page's server load is where the old system mock block lived.
	new URL('./+page.server.ts', import.meta.url)
]
	.map((url) => readFileSync(url, 'utf8'))
	.join('\n');

describe('System section removal (W10.3)', () => {
	it('has no system route', () => {
		expect(existsSync(new URL('./system/', import.meta.url))).toBe(false);
	});

	it('has no system nav entry', () => {
		expect(LAYOUT).not.toMatch(/id:\s*'system'/);
	});

	it('drops every admin_settings_system* key in all three locales', () => {
		for (const locale of LOCALES) {
			const messages = JSON.parse(
				readFileSync(new URL(`../../../../../messages/${locale}.json`, import.meta.url), 'utf8')
			) as Record<string, string>;
			expect(
				Object.keys(messages).filter((key) => key.startsWith('admin_settings_system')),
				locale
			).toEqual([]);
		}
	});

	it('keeps the four orphaned option names out of the registry and pages', () => {
		for (const source of [OPTIONS, PAGES_SOURCE, LAYOUT]) {
			expect(source).not.toMatch(/adminProxy|loginBg|amapKey|emailSubscription/);
		}
	});
});
