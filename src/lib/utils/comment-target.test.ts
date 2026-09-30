import { describe, expect, it } from 'vitest';
import { commentTargetDisplay, type CommentTargetRow } from './comment-target';

function row(overrides: Partial<CommentTargetRow>): CommentTargetRow {
	return {
		postId: null,
		postTitle: null,
		postSlug: null,
		noteId: null,
		noteTitle: null,
		noteSlug: null,
		pageId: null,
		pageTitle: null,
		pageSlug: null,
		...overrides
	};
}

describe('commentTargetDisplay', () => {
	it('resolves post rows with the front link', () => {
		expect(
			commentTargetDisplay(row({ postId: 'p1', postTitle: 'Hello world', postSlug: 'hello-world' }))
		).toEqual({ kind: 'post', label: '博文', title: 'Hello world', href: '/posts/hello-world' });
	});

	it('degrades to a slug title and a null href when the post row is gone', () => {
		// A dangling arc (target deleted hard) must not crash the queue.
		expect(commentTargetDisplay(row({ postId: 'p1' }))).toEqual({
			kind: 'post',
			label: '博文',
			title: '（未知）',
			href: null
		});
	});

	it('resolves note rows (the item absorbed from N1)', () => {
		expect(
			commentTargetDisplay(row({ noteId: 'n1', noteTitle: '日记', noteSlug: 'diary-1' }))
		).toEqual({ kind: 'note', label: '笔记', title: '日记', href: '/notes/diary-1' });
	});

	it('flattens the pages jsonb title in en -> zh-cn -> ja order', () => {
		expect(
			commentTargetDisplay(
				row({ pageId: 'g1', pageTitle: { ja: 'ページ', en: 'About' }, pageSlug: 'about' })
			)
		).toEqual({ kind: 'page', label: '页面', title: 'About', href: '/about' });
		expect(
			commentTargetDisplay(row({ pageId: 'g1', pageTitle: { 'zh-cn': '关于' }, pageSlug: 'about' }))
				?.title
		).toBe('关于');
	});

	it('returns null when no arc column is set', () => {
		expect(commentTargetDisplay(row({}))).toBeNull();
	});
});
