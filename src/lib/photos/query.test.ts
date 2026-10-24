import { describe, expect, it } from 'vitest';
import {
	activePhotoFilterCount,
	parsePhotoQuery,
	photoQueryParams,
	togglePhotoFilter,
	type PhotoQuery
} from './query';

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('photo query grammar', () => {
	it('parses repeated filters, tag mode, search and columns', () => {
		const query = parsePhotoQuery(
			new URLSearchParams(
				`year=2025&year=2024&year=abcd&camera=X-T5&camera=X100&lens=XF+35&tag=${UUID_A}&tag=${UUID_B}&tag=bad&tagMode=all&q=+sunset+&cols=4&c=ignored`
			)
		);
		expect(query).toEqual({
			years: [2025, 2024],
			cameras: ['X-T5', 'X100'],
			lenses: ['XF 35'],
			tagIds: [UUID_A, UUID_B],
			tagMode: 'all',
			q: 'sunset',
			columns: '4'
		});
	});

	it('falls back to safe defaults for malformed values', () => {
		expect(parsePhotoQuery(new URLSearchParams('year=1&cols=7&tagMode=maybe'))).toEqual({
			years: [],
			cameras: [],
			lenses: [],
			tagIds: [],
			tagMode: 'any',
			q: '',
			columns: 'auto'
		});
	});

	it('serializes in a stable order and omits defaults', () => {
		const query: PhotoQuery = {
			years: [2024, 2025],
			cameras: ['X-T5'],
			lenses: [],
			tagIds: [UUID_A],
			tagMode: 'all',
			q: 'sunset',
			columns: '3'
		};
		const params = photoQueryParams(query);
		expect(params.toString()).toBe(
			`year=2024&year=2025&camera=X-T5&tag=${UUID_A}&tagMode=all&q=sunset&cols=3`
		);
		expect(
			photoQueryParams({
				...query,
				years: [],
				cameras: [],
				tagIds: [],
				q: '',
				columns: 'auto',
				tagMode: 'any'
			}).toString()
		).toBe('');
	});

	it('toggles one value without mutating the source query', () => {
		const query = parsePhotoQuery(new URLSearchParams(`year=2024&tag=${UUID_A}`));
		const added = togglePhotoFilter(query, 'years', 2025);
		const removed = togglePhotoFilter(added, 'years', 2024);
		expect(added.years).toEqual([2024, 2025]);
		expect(removed.years).toEqual([2025]);
		expect(query.years).toEqual([2024]);
	});

	it('counts active values, including search but not tag mode', () => {
		expect(
			activePhotoFilterCount({
				years: [2024],
				cameras: ['X-T5'],
				lenses: [],
				tagIds: [UUID_A],
				tagMode: 'all',
				q: 'sunset',
				columns: 'auto'
			})
		).toBe(4);
	});
});
