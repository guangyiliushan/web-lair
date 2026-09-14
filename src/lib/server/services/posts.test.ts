import { describe, expect, it } from 'vitest';
import { parseTags, validatePostForm } from './posts';

describe('validatePostForm', () => {
	it('accepts a valid form with no errors', () => {
		const errors = validatePostForm({
			title: 'Hello World',
			slug: 'hello-world',
			categoryId: 'cat-1',
			summary: '',
			content: 'Some **markdown** content',
			isPublished: true
		});
		expect(errors).toEqual({});
	});

	it('requires a title', () => {
		const errors = validatePostForm({
			title: '   ',
			slug: 'hello-world',
			categoryId: 'cat-1',
			summary: '',
			content: 'content',
			isPublished: true
		});
		expect(errors.title).toBe('标题不能为空');
	});

	it('requires a slug', () => {
		const errors = validatePostForm({
			title: 'Hello',
			slug: '',
			categoryId: 'cat-1',
			summary: '',
			content: 'content',
			isPublished: true
		});
		expect(errors.slug).toBe('Slug 不能为空');
	});

	it('rejects slugs with characters other than lowercase letters, digits and hyphens', () => {
		const errors = validatePostForm({
			title: 'Hello',
			slug: 'Not A Valid Slug!',
			categoryId: 'cat-1',
			summary: '',
			content: 'content',
			isPublished: true
		});
		expect(errors.slug).toBe('Slug 仅允许小写英文、数字和连字符');
	});

	it('rejects slugs with leading, trailing or repeated hyphens', () => {
		for (const slug of ['-abc', 'abc-', 'a--b']) {
			const errors = validatePostForm({
				title: 'Hello',
				slug,
				categoryId: 'cat-1',
				summary: '',
				content: 'content',
				isPublished: true
			});
			expect(errors.slug, `slug=${slug}`).toBe('Slug 仅允许小写英文、数字和连字符');
		}
	});

	it('accepts single-word slugs', () => {
		const errors = validatePostForm({
			title: 'Hello',
			slug: 'abc123',
			categoryId: 'cat-1',
			summary: '',
			content: 'content',
			isPublished: true
		});
		expect(errors.slug).toBeUndefined();
	});

	it('requires a category', () => {
		const errors = validatePostForm({
			title: 'Hello',
			slug: 'hello',
			categoryId: '',
			summary: '',
			content: 'content',
			isPublished: true
		});
		expect(errors.categoryId).toBe('请选择分类');
	});

	it('requires non-blank content', () => {
		const errors = validatePostForm({
			title: 'Hello',
			slug: 'hello',
			categoryId: 'cat-1',
			summary: '',
			content: '   \n  ',
			isPublished: true
		});
		expect(errors.content).toBe('正文不能为空');
	});

	it('collects multiple field errors at once', () => {
		const errors = validatePostForm({
			title: '',
			slug: '',
			categoryId: '',
			summary: '',
			content: '',
			isPublished: true
		});
		expect(Object.keys(errors).sort()).toEqual(['categoryId', 'content', 'slug', 'title']);
	});
});

describe('parseTags', () => {
	it('splits a comma separated string into trimmed tags', () => {
		expect(parseTags('svelte, typescript ,  tutorial')).toEqual([
			'svelte',
			'typescript',
			'tutorial'
		]);
	});

	it('drops empty segments', () => {
		expect(parseTags('a,,b, , c,')).toEqual(['a', 'b', 'c']);
	});

	it('returns an empty array for blank input', () => {
		expect(parseTags('')).toEqual([]);
		expect(parseTags(undefined)).toEqual([]);
	});
});
