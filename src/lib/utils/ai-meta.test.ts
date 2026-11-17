import { describe, expect, it } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import {
	AI_FUNCTION_LABELS,
	AI_PROVIDER_KIND_LABELS,
	enabledModelIds,
	mergeDiscoveredModels,
	mergeModelEntries,
	normalizeModelEntries
} from './ai-meta';

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

describe('AI model entries', () => {
	it('normalizes the legacy string[] shape as enabled manual entries', () => {
		expect(normalizeModelEntries(['gpt-a', ' gpt-b ', ''])).toEqual([
			{ id: 'gpt-a', enabled: true, source: 'manual' },
			{ id: 'gpt-b', enabled: true, source: 'manual' }
		]);
	});

	it('drops malformed entries and duplicate ids', () => {
		expect(
			normalizeModelEntries([
				{ id: 'a', enabled: false, source: 'discovered' },
				{ id: 'a', enabled: true, source: 'manual' },
				{ nope: true },
				null
			])
		).toEqual([{ id: 'a', enabled: false, source: 'discovered' }]);
	});

	it('mergeModelEntries disables removed ids and adds new manual ids', () => {
		const existing = [
			{ id: 'a', enabled: true, source: 'manual' as const },
			{ id: 'b', enabled: true, source: 'manual' as const }
		];
		expect(mergeModelEntries(existing, ['b', 'c'])).toEqual([
			{ id: 'a', enabled: false, source: 'manual' },
			{ id: 'b', enabled: true, source: 'manual' },
			{ id: 'c', enabled: true, source: 'manual' }
		]);
	});

	it('mergeDiscoveredModels adds new ids disabled and refreshes lastSeenAt', () => {
		const existing = [{ id: 'a', enabled: true, source: 'manual' as const }];
		const merged = mergeDiscoveredModels(existing, ['a', 'b'], '2026-11-04T00:00:00.000Z');
		expect(merged).toEqual([
			{ id: 'a', enabled: true, source: 'manual', lastSeenAt: '2026-11-04T00:00:00.000Z' },
			{
				id: 'b',
				enabled: false,
				source: 'discovered',
				lastSeenAt: '2026-11-04T00:00:00.000Z'
			}
		]);
		expect(enabledModelIds(merged)).toEqual(['a']);
	});
});
