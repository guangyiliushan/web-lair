import { describe, expect, it } from 'vitest';
import { commentTargetDisplay, type CommentTargetRow } from './comment-target';

function row(overrides: Partial<CommentTargetRow>): CommentTargetRow {
	return {
		postId: null,
		postTitle: null,
		postSlug: null,
		postLang: null,
		noteId: null,
		noteTitle: null,
		noteSlug: null,
		noteLang: null,
		pageId: null,
		pageTitle: null,
		pageSlug: null,
		...overrides
	};
}

describe('commentTargetDisplay', () => {
	it('resolves post rows with a localized front link', () => {
		expect(
			commentTargetDisplay(
				row({
					postId: 'p1',
					postTitle: 'Hello world',
					postSlug: 'hello-world',
					postLang: 'zh-cn'
				})
			)
		).toEqual({ label: '博文', title: 'Hello world', href: '/zh-cn/posts/hello-world' });
	});

	it('falls back to the plain path for an unknown or missing language', () => {
		expect(commentTargetDisplay(row({ postId: 'p1', postSlug: 'x', postLang: 'fr' }))?.href).toBe(
			'/posts/x'
		);
		expect(commentTargetDisplay(row({ postId: 'p1', postSlug: 'x', postLang: null }))?.href).toBe(
			'/posts/x'
		);
	});

	it('keeps an id hint and a null href when the target row is gone', () => {
		// The old queue showed an id fragment for dangling rows; it is the only
		// manual-location clue left, so the fallback keeps it (code review).
		expect(commentTargetDisplay(row({ postId: '12345678-aaaa-bbbb-cccc-dddddddddddd' }))).toEqual({
			label: '博文',
			title: '（未知 · 12345678…）',
			href: null
		});
	});

	it('resolves note rows with a localized front link (absorbed from N1)', () => {
		expect(
			commentTargetDisplay(
				row({ noteId: 'n1', noteTitle: '日记', noteSlug: 'diary-1', noteLang: 'ja' })
			)
		).toEqual({ label: '笔记', title: '日记', href: '/ja/notes/diary-1' });
	});

	it('flattens the pages jsonb title in the paraglide locale order', () => {
		// Discriminating pair: zh-cn must win over ja (the "site order"), en
		// stays the global first choice.
		expect(
			commentTargetDisplay(
				row({ pageId: 'g1', pageTitle: { ja: 'ページ', 'zh-cn': '关于' }, pageSlug: 'about' })
			)
		).toEqual({ label: '页面', title: '关于', href: '/about' });
		expect(
			commentTargetDisplay(row({ pageId: 'g1', pageTitle: { en: 'About' }, pageSlug: 'about' }))
				?.title
		).toBe('About');
	});

	it('returns null when no arc column is set', () => {
		expect(commentTargetDisplay(row({}))).toBeNull();
	});
});
