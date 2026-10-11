import { describe, expect, it } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { AI_FUNCTION_LABELS, AI_PROVIDER_KIND_LABELS } from './ai-meta';

// The maps render in settings/ai; pin the locale so the zh-cn spot checks
// stay meaningful even though the lookup itself reads getLocale()
// (same convention as maintenance-form-utils.test.ts).
overwriteGetLocale(() => 'zh-cn');

describe('ai-meta label maps', () => {
	const maps = [
		['AI_PROVIDER_KIND_LABELS', AI_PROVIDER_KIND_LABELS],
		['AI_FUNCTION_LABELS', AI_FUNCTION_LABELS]
	] as const;

	for (const [name, map] of maps) {
		it(`${name} carries a non-empty label for every locale`, () => {
			const entries = Object.entries(map);
			expect(entries.length).toBeGreaterThan(0);
			for (const [key, labels] of entries) {
				for (const locale of ['en', 'zh-cn', 'ja'] as const) {
					expect(labels[locale], `${name}.${key}.${locale}`).toBeTruthy();
				}
			}
		});
	}

	it('zh-cn spot checks stay aligned with the catalog voice', () => {
		expect(AI_PROVIDER_KIND_LABELS.custom['zh-cn']).toBe('自定义');
		expect(AI_FUNCTION_LABELS.summary['zh-cn']).toBe('摘要');
	});
});
