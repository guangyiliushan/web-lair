import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import CommentsSection from './CommentsSection.svelte';
import type { ThreadReply, ThreadRoot, ThreadsPage } from './types';

// Pin the UI locale for copy assertions (official paraglide escape hatch,
// mirrors toolbar-formats.svelte.spec.ts).
overwriteGetLocale(() => 'zh-cn');

function root(overrides: Partial<ThreadRoot> = {}): ThreadRoot {
	return {
		id: 'root-1',
		text: '你好',
		author: 'Alice',
		avatar: null,
		isOwner: false,
		isPending: false,
		createdAt: new Date('2026-09-29T12:00:00Z'),
		pin: false,
		isDeleted: false,
		replies: [],
		...overrides
	};
}

function reply(overrides: Partial<ThreadReply> = {}): ThreadReply {
	return {
		id: 'reply-1',
		text: '收到',
		author: 'Bob',
		avatar: null,
		isOwner: false,
		isPending: false,
		createdAt: new Date('2026-09-29T13:00:00Z'),
		replyToAuthor: null,
		...overrides
	};
}

function threadsPage(roots: ThreadRoot[], overrides: Partial<ThreadsPage> = {}): ThreadsPage {
	return {
		roots,
		visibleCount: roots.reduce((sum, item) => sum + 1 + item.replies.length, 0),
		truncated: false,
		...overrides
	};
}

const BASE = {
	targetType: 'post' as const,
	canComment: true,
	emailVerified: true,
	loginUrl: null,
	form: null
};

describe('CommentsSection', () => {
	it('renders title with count, empty state and the composer', async () => {
		await render(CommentsSection, { ...BASE, threads: threadsPage([]) });
		await expect.element(page.getByRole('heading', { name: /评论/ })).toBeInTheDocument();
		await expect.element(page.getByText('还没有评论，来说点什么吧。')).toBeInTheDocument();
		await expect.element(page.getByRole('textbox', { name: '评论内容' })).toBeInTheDocument();
		expect(document.querySelector('#comments')?.getAttribute('data-comment-target')).toBe('post');
	});

	it('guides guests to sign in instead of showing the composer', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([]),
			canComment: false,
			emailVerified: false,
			loginUrl: '/login?redirectTo=%2Fposts%2Fx'
		});
		await expect.element(page.getByText('登录后参与讨论。')).toBeInTheDocument();
		const link = page.getByRole('link', { name: '登录' });
		await expect.element(link).toBeInTheDocument();
		await expect.element(link).toHaveAttribute('href', '/login?redirectTo=%2Fposts%2Fx');
		expect(document.querySelectorAll('textarea').length).toBe(0);
	});

	it('shows the verify-email hint for signed-in unverified readers', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([]),
			canComment: false,
			emailVerified: false
		});
		await expect.element(page.getByText('验证邮箱后即可发表评论。')).toBeInTheDocument();
		expect(document.querySelectorAll('textarea').length).toBe(0);
	});

	it('renders owner, pending and pin badges plus the thread count', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([root({ isOwner: true, isPending: true, pin: true })])
		});
		await expect.element(page.getByText('站长')).toBeInTheDocument();
		await expect.element(page.getByText('审核中')).toBeInTheDocument();
		await expect.element(page.getByText('置顶')).toBeInTheDocument();
		await expect.element(page.getByRole('heading', { name: /评论/ })).toHaveTextContent('(1)');
	});

	it('renders owner/pending badges on replies too', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([root({ replies: [reply({ isOwner: true, isPending: true })] })])
		});
		const item = document.querySelector('[data-comment-id="reply-1"]');
		expect(item?.textContent).toContain('站长');
		expect(item?.textContent).toContain('审核中');
	});

	it('hides the reply entry on pending rows (the server would refuse them)', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([root({ isPending: true })])
		});
		expect(document.querySelector('[data-reply-target="root-1"]')).toBeNull();
	});

	it('keeps the floor for a deleted root while its replies stay visible', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([root({ isDeleted: true, text: '', author: null, replies: [reply()] })])
		});
		await expect.element(page.getByText('该评论已删除。')).toBeInTheDocument();
		await expect.element(page.getByText('收到')).toBeInTheDocument();
		expect(document.body.textContent).not.toContain('Alice');
	});

	it('resolves the reply chip only for nested replies', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([
				root({
					replies: [
						reply({ id: 'reply-1', author: 'Bob' }),
						reply({ id: 'reply-2', author: 'Cara', replyToAuthor: 'Bob' })
					]
				})
			])
		});
		await expect.element(page.getByText('回复 Bob')).toBeInTheDocument();
		expect(document.querySelectorAll('[data-comment-id="root-1"] time').length).toBe(3);
	});

	it('autolinks http(s) URLs with the hardened rel set and keeps exact text', async () => {
		const text = '看这个 https://example.com/a 吧';
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([root({ text })])
		});
		const anchor = document.querySelector('[data-comment-id="root-1"] a');
		expect(anchor?.getAttribute('href')).toBe('https://example.com/a');
		expect(anchor?.getAttribute('target')).toBe('_blank');
		const rel = anchor?.getAttribute('rel') ?? '';
		for (const value of ['nofollow', 'ugc', 'noopener', 'noreferrer']) {
			expect(rel).toContain(value);
		}
		// Whitespace nail: the segment template must not inject stray nodes.
		const body = document.querySelector('[data-comment-id="root-1"] [data-comment-body]');
		expect(body?.textContent).toBe(text);
	});

	it('toggles one inline reply composer at a time with the right parent id', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([root({ replies: [reply()] })])
		});
		const clickReplyTarget = async (id: string) => {
			const button = document.querySelector(`[data-reply-target="${id}"]`);
			if (!button) throw new Error(`reply button for ${id} not found`);
			await page.elementLocator(button).click();
		};
		expect(document.querySelectorAll('textarea').length).toBe(1);

		await clickReplyTarget('root-1');
		await expect.poll(() => document.querySelectorAll('textarea').length).toBe(2);
		expect(document.querySelector('input[name="parentId"]')?.getAttribute('value')).toBe('root-1');
		expect(
			document.querySelector('input[name="parentId"]')?.closest('form')?.getAttribute('action')
		).toBe('?/reply');
		expect(
			document.querySelector('[data-reply-target="root-1"]')?.getAttribute('aria-expanded')
		).toBe('true');

		await clickReplyTarget('reply-1');
		await expect
			.poll(() => document.querySelector('input[name="parentId"]')?.getAttribute('value'))
			.toBe('reply-1');
		expect(document.querySelectorAll('textarea').length).toBe(2);

		await page.getByRole('button', { name: '取消' }).click();
		await expect.poll(() => document.querySelectorAll('textarea').length).toBe(1);
	});

	it('nails the success flash and the error alert', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([]),
			form: { submitted: 'pending' }
		});
		await expect.element(page.getByText('已提交，待审核。')).toBeInTheDocument();
	});

	it('renders a failed submission as an alert', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([]),
			form: { message: '提交失败' }
		});
		const alert = document.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('提交失败');
	});

	it('shows the truncation note when the page was capped', async () => {
		await render(CommentsSection, {
			...BASE,
			threads: threadsPage([root()], { truncated: true })
		});
		await expect.element(page.getByText('评论过多，仅显示前一部分。')).toBeInTheDocument();
	});
});
