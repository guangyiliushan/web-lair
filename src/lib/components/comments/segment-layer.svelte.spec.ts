import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import SegmentCommentLayer from './SegmentCommentLayer.svelte';
import type { ThreadsPage } from './types';

overwriteGetLocale(() => 'zh-cn');

/**
 * The layer owns the browser-only half of segment comments (comment P3b,
 * spec §5/§8): floating action on a legal selection, composer panel, login
 * path for guests, and the in-place thread opened from a mark. The page mounts
 * it next to the article; these cases mount it against a container directly so
 * the page wiring cannot hide a regression here.
 */
const threads: ThreadsPage = { roots: [], visibleCount: 0, truncated: false };

const hosts: HTMLElement[] = [];

function host(html: string): HTMLElement {
	const element = document.createElement('div');
	element.innerHTML = html;
	document.body.appendChild(element);
	hosts.push(element);
	return element;
}

async function select(paragraph: HTMLElement, needle: string) {
	const node = paragraph.firstChild as Text;
	const start = node.data.indexOf(needle);
	const range = document.createRange();
	range.setStart(node, start);
	range.setEnd(node, start + needle.length);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	document.dispatchEvent(new Event('selectionchange'));
	paragraph.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 200));
}

/** Force media-query answers so shape/hover branches are testable headlessly. */
function mockMatchMedia(matches: (query: string) => boolean): () => void {
	const original = window.matchMedia;
	window.matchMedia = ((query: string) => ({
		matches: matches(query),
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false
	})) as typeof window.matchMedia;
	return () => {
		window.matchMedia = original;
	};
}

const layerThreads: ThreadsPage = {
	roots: [
		{
			id: 'root-1',
			text: '就地线程内容',
			author: 'Alice',
			avatar: null,
			isOwner: false,
			isPending: false,
			createdAt: new Date('2026-10-01T00:00:00Z'),
			editedAt: null,
			isMine: false,
			pin: false,
			isDeleted: false,
			anchor: { quote: '选中', orphaned: false, targetId: 'c-root-1' },
			replies: []
		}
	],
	visibleCount: 1,
	truncated: false
};

afterEach(() => {
	for (const element of hosts.splice(0)) element.remove();
	window.getSelection()?.removeAllRanges();
});

describe('segment comment layer', () => {
	it('shows the action for a selection and opens the composer with the anchor payload', async () => {
		const container = host('<p>第一段：选择这段文字来评论。</p>');
		const paragraph = container.querySelector('p') as HTMLElement;
		render(SegmentCommentLayer, {
			container,
			threads,
			canComment: true,
			loginUrl: null
		});
		await select(paragraph, '选择这段文字');
		const action = document.querySelector<HTMLButtonElement>(
			'[data-slot="comment-selection-action"]'
		);
		expect(action).not.toBeNull();
		expect(action?.textContent?.trim()).toBe('评论选中文字');
		action?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const panel = document.querySelector<HTMLElement>('[data-slot="comment-selection-panel"]');
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain('选中：选择这段文字');
		const hidden = [...(panel?.querySelectorAll<HTMLInputElement>('input[type="hidden"]') ?? [])];
		const values = Object.fromEntries(hidden.map((input) => [input.name, input.value]));
		expect(values).toMatchObject({
			anchorOrd: '0',
			anchorStart: '4',
			anchorEnd: '10',
			anchorExact: '选择这段文字',
			anchorLength: '14'
		});
	});

	it('offers the login path to a guest instead of a composer', async () => {
		const container = host('<p>第一段：选择这段文字来评论。</p>');
		const paragraph = container.querySelector('p') as HTMLElement;
		render(SegmentCommentLayer, {
			container,
			threads,
			canComment: false,
			loginUrl: '/login'
		});
		await select(paragraph, '选择这段文字');
		document.querySelector<HTMLButtonElement>('[data-slot="comment-selection-action"]')?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const panel = document.querySelector<HTMLElement>('[data-slot="comment-selection-panel"]');
		expect(panel?.textContent).toContain('登录后参与讨论。');
		expect(panel?.querySelector('textarea')).toBeNull();
	});

	it('surfaces a stale-anchor failure inside the panel', async () => {
		const container = host('<p>第一段：选择这段文字来评论。</p>');
		const paragraph = container.querySelector('p') as HTMLElement;
		render(SegmentCommentLayer, {
			container,
			threads,
			canComment: true,
			loginUrl: null,
			form: { message: '文章已更新，请刷新后重新选择' }
		});
		await select(paragraph, '选择这段文字');
		document.querySelector<HTMLButtonElement>('[data-slot="comment-selection-action"]')?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const panel = document.querySelector<HTMLElement>('[data-slot="comment-selection-panel"]');
		expect(panel?.textContent).toContain('文章已更新，请刷新后重新选择');
	});

	it('does not offer the action for a cross-block selection', async () => {
		const container = host('<p>第一段文字。</p><p>第二段文字。</p>');
		const paragraphs = container.querySelectorAll('p');
		render(SegmentCommentLayer, {
			container,
			threads,
			canComment: true,
			loginUrl: null
		});
		const range = document.createRange();
		range.setStart(paragraphs[0].firstChild as Text, 1);
		range.setEnd(paragraphs[1].firstChild as Text, 2);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(document.querySelector('[data-slot="comment-selection-action"]')).toBeNull();
	});

	it('opens the in-place thread when a mark is clicked', async () => {
		const container = host('<p>前文<span class="wl-cm" data-cid="root-1">选中</span>后文</p>');
		render(SegmentCommentLayer, {
			container,
			threads: layerThreads,
			canComment: true,
			loginUrl: null
		});
		(container.querySelector('.wl-cm') as HTMLElement).dispatchEvent(
			new MouseEvent('click', { bubbles: true })
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const popover = document.querySelector<HTMLElement>('[data-slot="comment-thread-popover"]');
		expect(popover).not.toBeNull();
		expect(popover?.textContent).toContain('就地线程内容');
	});

	it('shows the summary card while hovering a mark (desktop pointer)', async () => {
		const restore = mockMatchMedia((query) => query.includes('hover'));
		try {
			const container = host('<p>前文<span class="wl-cm" data-cid="root-1">选中</span>后文</p>');
			render(SegmentCommentLayer, {
				container,
				threads: layerThreads,
				canComment: true,
				loginUrl: null
			});
			const mark = container.querySelector('.wl-cm') as HTMLElement;
			mark.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
			await new Promise((resolve) => setTimeout(resolve, 220));
			const card = document.querySelector<HTMLElement>('[data-slot="comment-mark-hover"]');
			expect(card).not.toBeNull();
			expect(card?.textContent).toContain('就地线程内容');
			expect(card?.textContent).toContain('Alice');
			expect(card?.getAttribute('aria-hidden')).toBe('true');
			mark.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(document.querySelector('[data-slot="comment-mark-hover"]')).toBeNull();
		} finally {
			restore();
		}
	});

	it('renders the composer as a bottom sheet on narrow viewports', async () => {
		const restore = mockMatchMedia((query) => query.includes('max-width'));
		try {
			const container = host('<p>第一段：选择这段文字来评论。</p>');
			const paragraph = container.querySelector('p') as HTMLElement;
			render(SegmentCommentLayer, {
				container,
				threads,
				canComment: true,
				loginUrl: null
			});
			await select(paragraph, '选择这段文字');
			document.querySelector<HTMLButtonElement>('[data-slot="comment-selection-action"]')?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			const panel = document.querySelector<HTMLElement>('[data-slot="comment-selection-panel"]');
			expect(panel?.getAttribute('data-shape')).toBe('sheet');
			expect(panel?.className).toContain('inset-x-0');
			expect(panel?.getAttribute('style')).toBe('');
		} finally {
			restore();
		}
	});

	it('keeps the thread popover alive for a pointerdown inside it', async () => {
		const container = host('<p>前文<span class="wl-cm" data-cid="root-1">选中</span>后文</p>');
		render(SegmentCommentLayer, {
			container,
			threads: layerThreads,
			canComment: true,
			loginUrl: null
		});
		const mark = container.querySelector('.wl-cm') as HTMLElement;
		mark.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const popover = document.querySelector<HTMLElement>('[data-slot="comment-thread-popover"]');
		expect(popover).not.toBeNull();
		const control = popover?.querySelector('button') as HTMLElement;
		control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		// Regression: every pointerdown inside the popover used to close it
		// before the click could run, so all controls were dead for mice.
		expect(document.querySelector('[data-slot="comment-thread-popover"]')).not.toBeNull();
		control.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector('[data-slot="comment-thread-popover"]')).toBeNull();
	});

	it('opens the thread from the keyboard and returns focus to the mark', async () => {
		const container = host('<p>前文<span class="wl-cm" data-cid="root-1">选中</span>后文</p>');
		render(SegmentCommentLayer, {
			container,
			threads: layerThreads,
			canComment: true,
			loginUrl: null
		});
		const mark = container.querySelector('.wl-cm') as HTMLElement;
		mark.tabIndex = 0;
		mark.focus();
		mark.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const popover = document.querySelector<HTMLElement>('[data-slot="comment-thread-popover"]');
		expect(popover).not.toBeNull();
		// Focus lands inside the dialog (2.4.3), not on <body>.
		expect(popover?.contains(document.activeElement)).toBe(true);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector('[data-slot="comment-thread-popover"]')).toBeNull();
		expect(document.activeElement).toBe(mark);
	});

	it('returns focus to the comments heading when the composer closes', async () => {
		const title = document.createElement('h2');
		title.id = 'comments-title';
		title.tabIndex = -1;
		document.body.appendChild(title);
		hosts.push(title);
		const container = host('<p>第一段：选择这段文字来评论。</p>');
		const paragraph = container.querySelector('p') as HTMLElement;
		render(SegmentCommentLayer, {
			container,
			threads,
			canComment: true,
			loginUrl: null
		});
		await select(paragraph, '选择这段文字');
		document.querySelector<HTMLButtonElement>('[data-slot="comment-selection-action"]')?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector('[data-slot="comment-selection-panel"]')).toBeNull();
		expect(document.activeElement).toBe(title);
	});

	it('keeps Tab inside the open composer (modal contract)', async () => {
		const container = host('<p>第一段：选择这段文字来评论。</p>');
		const paragraph = container.querySelector('p') as HTMLElement;
		render(SegmentCommentLayer, {
			container,
			threads,
			canComment: true,
			loginUrl: null
		});
		await select(paragraph, '选择这段文字');
		document.querySelector<HTMLButtonElement>('[data-slot="comment-selection-action"]')?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const panel = document.querySelector<HTMLElement>('[data-slot="comment-selection-panel"]');
		expect(panel?.getAttribute('aria-modal')).toBe('true');
		const submit = panel?.querySelector<HTMLButtonElement>('button[type="submit"]');
		submit?.focus();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(panel?.contains(document.activeElement)).toBe(true);
	});

	it('does not navigate when a mark wraps link text', async () => {
		const container = host(
			'<p>前文<a href="#elsewhere"><span class="wl-cm" data-cid="root-1">选中</span></a>后文</p>'
		);
		render(SegmentCommentLayer, {
			container,
			threads: layerThreads,
			canComment: true,
			loginUrl: null
		});
		const mark = container.querySelector('.wl-cm') as HTMLElement;
		const click = new MouseEvent('click', { bubbles: true, cancelable: true });
		mark.dispatchEvent(click);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(click.defaultPrevented).toBe(true);
	});
});
