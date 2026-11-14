import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { optionKeys, optionRegistry } from './options-registry';

/**
 * W6.8 (C6/C7): paid membership ships as a design contract only. This suite
 * pins the boundary so a future batch cannot half-land it: the flag is off by
 * default, there is no paid/member access option, no payment route, and the
 * Content settings page offers no paid switch.
 *
 * The full contract (access modes, preview, entitlement, SEO, leak surfaces,
 * provider/tax/refund trigger) lives in the decision register §3C.4.
 */
describe('payments contract boundary', () => {
	it('keeps payments.enabled off by default', () => {
		expect(optionRegistry['payments.enabled']?.default).toBe(false);
		expect(optionKeys).toContain('payments.enabled');
	});

	it('has no paid/member access mode option', () => {
		expect(optionKeys.filter((key) => /access|member|paid|plan|price/i.test(key))).toEqual([]);
	});

	it('ships no payment or membership route', () => {
		for (const segment of [
			'../../../routes/(site)/payments',
			'../../../routes/(site)/membership',
			'../../../routes/(admin)/admin/payments',
			'../../../routes/(admin)/admin/settings/payments'
		]) {
			expect(existsSync(new URL(segment, import.meta.url)), segment).toBe(false);
		}
	});

	it('offers no paid/member control on the Content settings page', () => {
		const page = readFileSync(
			new URL('../../../routes/(admin)/admin/settings/content/+page.svelte', import.meta.url),
			'utf8'
		);
		expect(page).not.toMatch(/payments\.enabled|paid|membership|accessMode/i);
	});
});
