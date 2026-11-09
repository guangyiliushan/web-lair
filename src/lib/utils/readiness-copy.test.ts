import { describe, expect, it } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { AI_READINESS_STATUSES } from './ai-meta';
import { readinessCopy, readinessTitle } from './readiness-copy';

// The copy renders in the settings page, the console and the editors; pin the
// locale so the zh-cn spot checks stay meaningful (same convention as
// ai-meta.test.ts and the e2e fixtures that assert Chinese copy).
overwriteGetLocale(() => 'zh-cn');

/**
 * The readiness copy is what a disabled control explains itself with, so a
 * missing or duplicated string is a user-visible defect, not a typo. These
 * resolve through the real messages catalogue rather than the key names.
 */
describe('readiness copy', () => {
	it('renders real text for every status, never the key name', () => {
		for (const status of AI_READINESS_STATUSES) {
			const copy = readinessCopy(status);
			expect(copy.label.length).toBeGreaterThan(0);
			expect(copy.hint.length).toBeGreaterThan(0);
			expect(copy.label).not.toMatch(/^admin_/);
			expect(copy.hint).not.toMatch(/^admin_/);
			expect(copy.label).not.toBe(copy.hint);
		}
	});

	it('keeps one verdict per status', () => {
		const labels = AI_READINESS_STATUSES.map((status) => readinessCopy(status).label);
		expect(new Set(labels).size).toBe(AI_READINESS_STATUSES.length);
	});

	it('zh-cn verdicts read as the reason a button is disabled', () => {
		// The shape here is the one e2e/admin-ai.e2e.ts already asserts on
		// (`AI_E2E_MISSING_KEY 未设置`), so the two cannot drift apart.
		expect(readinessCopy('missing_env', { name: 'AI_OPENAI_KEY' }).hint).toBe(
			'AI_OPENAI_KEY 未设置'
		);
		expect(readinessCopy('not_wired').label).toBe('尚未接入');
		expect(readinessCopy('provider_disabled').label).toBe('服务商已禁用');
		expect(readinessCopy('ready').label).toBe('就绪');
	});
});

/**
 * The title a control carries. `readyHint` is what the action would do; every
 * other state must say why it cannot run instead - the branch the post editor
 * had inverted, so a disabled button explained the overwrite and an enabled one
 * just repeated its own label.
 */
describe('readinessTitle', () => {
	const fix = { href: '/admin/settings/ai#assignments', labelKey: 'admin_readiness_fix_assign' };

	it('describes the consequence when the action is available', () => {
		expect(readinessTitle({ status: 'ready' }, '将覆盖目标语言全部内容')).toBe(
			'将覆盖目标语言全部内容'
		);
	});

	it('gives the reason and the fix when it is not', () => {
		expect(readinessTitle({ status: 'unassigned', fix }, '将覆盖目标语言全部内容')).toBe(
			'未分配服务商 · 去分配'
		);
	});

	it('names the missing variable and where to set it', () => {
		expect(
			readinessTitle(
				{
					status: 'missing_env',
					envName: 'AI_OPENAI_KEY',
					fix: { href: '/admin/settings/ai#providers', labelKey: 'admin_readiness_fix_env' }
				},
				'x'
			)
		).toBe('AI_OPENAI_KEY 未设置 · 去设置密钥');
	});

	it('drops the action when there is nowhere to fix it', () => {
		// Not-wired is a capability gap: linking to settings would be a dead end.
		expect(readinessTitle({ status: 'not_wired', fix: null }, 'x')).toBe('尚未接入运行时');
	});

	it('never falls through to the ready hint for a broken state', () => {
		for (const status of [
			'unassigned',
			'provider_missing',
			'provider_disabled',
			'missing_env',
			'missing_model',
			'not_wired'
		] as const) {
			expect(readinessTitle({ status }, 'READY-HINT')).not.toContain('READY-HINT');
		}
	});
});
