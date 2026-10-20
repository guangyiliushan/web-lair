import { describe, expect, it } from 'vitest';
import { DEFAULT_POST_SORT, parsePostAiFilter, parsePostSort, postListHref } from './posts-list';

describe('parsePostSort', () => {
	it('accepts the three known values', () => {
		expect(parsePostSort('latest')).toBe('latest');
		expect(parsePostSort('oldest')).toBe('oldest');
		expect(parsePostSort('updated')).toBe('updated');
	});

	it('falls back to the default for missing, empty or unknown values', () => {
		expect(parsePostSort(null)).toBe(DEFAULT_POST_SORT);
		expect(parsePostSort(undefined)).toBe(DEFAULT_POST_SORT);
		expect(parsePostSort('')).toBe(DEFAULT_POST_SORT);
		expect(parsePostSort('featured')).toBe(DEFAULT_POST_SORT);
		expect(parsePostSort('LATEST')).toBe(DEFAULT_POST_SORT);
	});
});

describe('parsePostAiFilter', () => {
	it('accepts the known filter and rejects everything else', () => {
		expect(parsePostAiFilter('non-generated')).toBe('non-generated');
		expect(parsePostAiFilter(null)).toBeNull();
		expect(parsePostAiFilter(undefined)).toBeNull();
		expect(parsePostAiFilter('')).toBeNull();
		expect(parsePostAiFilter('ai')).toBeNull();
		expect(parsePostAiFilter('NON-GENERATED')).toBeNull();
	});
});

describe('postListHref', () => {
	it('omits the default sort and page 1', () => {
		expect(postListHref()).toBe('/posts');
		expect(postListHref({ sort: 'latest', page: 1 })).toBe('/posts');
	});

	it('keeps non-default sort values', () => {
		expect(postListHref({ sort: 'oldest' })).toBe('/posts?sort=oldest');
		expect(postListHref({ sort: 'updated' })).toBe('/posts?sort=updated');
	});

	it('keeps pagination and combines it with the sort', () => {
		expect(postListHref({ page: 2 })).toBe('/posts?page=2');
		expect(postListHref({ sort: 'oldest', page: 3 })).toBe('/posts?sort=oldest&page=3');
	});

	it('keeps the AI filter and combines it with sort and page', () => {
		expect(postListHref({ ai: 'non-generated' })).toBe('/posts?ai=non-generated');
		expect(postListHref({ ai: 'non-generated', sort: 'oldest' })).toBe(
			'/posts?ai=non-generated&sort=oldest'
		);
		expect(postListHref({ ai: 'non-generated', sort: 'updated', page: 2 })).toBe(
			'/posts?ai=non-generated&sort=updated&page=2'
		);
	});
});
