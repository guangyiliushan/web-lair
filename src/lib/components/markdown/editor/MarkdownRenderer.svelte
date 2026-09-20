<script lang="ts">
	import { onDestroy, mount, unmount } from 'svelte';
	import { cn } from '$lib/utils';
	import {
		renderMarkdownToHtmlSync,
		type MarkdownRendererProps
	} from '$lib/components/markdown/editor/markdown-config';
	import EmbedCard from '$lib/components/markdown/embed/EmbedCard.svelte';
	import type { EmbedProviderId } from '$lib/components/markdown/embed/registry';
	import { scheduleMermaidRender, scheduleMermaidRerender } from './mermaid-client';
	import { themeStore } from '$lib/stores/theme.svelte';

	let {
		source,
		html: htmlProp,
		class: className,
		prose = false,
		children
	}: MarkdownRendererProps = $props();

	// 优先使用预渲染 HTML（SSR 场景由 +page.server.ts 传入）
	// 否则客户端同步渲染（无 Shiki 高亮）
	const renderedHtml = $derived(htmlProp ?? (source ? renderMarkdownToHtmlSync(source) : ''));
	const isEmpty = $derived(!renderedHtml);

	// Client enhancement (spec 3.4/7): upgrade every placeholder anchor to a
	// card component. SSR and no-JS keep the anchors themselves, so the
	// fallback stays a working plain link.
	let articleEl: HTMLElement | undefined = $state();
	const cardInstances: Array<ReturnType<typeof mount>> = [];
	let uid = '';

	// The enhancement is reactive: `{@html}` swaps the article's children
	// whenever the rendered HTML changes, so the effect re-runs after every
	// such update — previously-mounted cards are unmounted first, the fresh
	// nodes are enhanced and the new anchors upgraded again.
	$effect(() => {
		void renderedHtml;
		const article = articleEl;
		if (!article) return;
		for (const instance of cardInstances) unmount(instance);
		cardInstances.length = 0;
		uid ||= Math.random().toString(36).slice(2, 8);
		enhanceTabs(article, uid);
		for (const anchor of article.querySelectorAll('a.embed-card')) {
			// The data-embed attribute is pipeline output from the closed registry
			const provider = (anchor.getAttribute('data-embed') ?? 'generic') as
				| EmbedProviderId
				| 'generic';
			const url = anchor.getAttribute('data-url') ?? anchor.getAttribute('href') ?? '';
			const title = anchor.textContent?.trim() || url;
			const host = document.createElement('div');
			anchor.replaceWith(host);
			cardInstances.push(mount(EmbedCard, { target: host, props: { provider, url, title } }));
		}
		// mermaid diagrams (spec 3.3/7): lazy import + render, raw text degrades
		scheduleMermaidRender([...article.querySelectorAll<HTMLElement>('.mermaid')]);
	});

	// A theme flip re-renders the diagrams (their palette is baked at render
	// time); the first run finds nothing archived and is a no-op.
	$effect(() => {
		void themeStore.resolved;
		const article = articleEl;
		if (!article) return;
		scheduleMermaidRerender(article);
	});
	onDestroy(() => {
		for (const instance of cardInstances) unmount(instance);
		cardInstances.length = 0;
	});

	/**
	 * Tabs enhancement (spec 3.2): ARIA tablist with arrow/Home/End keys. The
	 * no-JS state stays all-panels-expanded with visible labels; this only
	 * collapses them once scripting is available. Listeners live on nodes that
	 * are removed with the article, so no manual teardown is needed.
	 */
	function enhanceTabs(article: HTMLElement, uid: string): void {
		article.querySelectorAll('.md-tabs').forEach((tabs, tabsIndex) => {
			const panels = Array.from(tabs.children).filter(
				(child): child is HTMLElement =>
					child instanceof HTMLElement && child.classList.contains('md-tab')
			);
			const labels = panels
				.map((panel) =>
					Array.from(panel.children).find(
						(child): child is HTMLElement =>
							child instanceof HTMLElement && child.classList.contains('md-tab-label')
					)
				)
				.filter((label): label is HTMLElement => label !== undefined);
			if (panels.length === 0 || labels.length !== panels.length) return;

			tabs.setAttribute('role', 'tablist');

			const activate = (activeIndex: number, focus = false) => {
				panels.forEach((panel, index) => {
					const label = labels[index];
					const active = index === activeIndex;
					const panelId = `md-tab-${uid}-${tabsIndex}-${index}`;
					panel.id = panelId;
					label.id = `${panelId}-label`;
					label.setAttribute('role', 'tab');
					label.setAttribute('aria-selected', String(active));
					label.setAttribute('aria-controls', panelId);
					label.tabIndex = active ? 0 : -1;
					panel.setAttribute('role', 'tabpanel');
					panel.setAttribute('aria-labelledby', label.id);
					panel.toggleAttribute('hidden', !active);
				});
				if (focus) labels[activeIndex].focus();
			};

			const count = panels.length;
			labels.forEach((label, index) => {
				label.addEventListener('click', () => activate(index));
				label.addEventListener('keydown', (event) => {
					// Enter/Space activate the focused tab (ARIA tabs pattern)
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						activate(index, true);
						return;
					}
					let next: number;
					if (event.key === 'ArrowRight') next = (index + 1) % count;
					else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
					else if (event.key === 'Home') next = 0;
					else if (event.key === 'End') next = count - 1;
					else return;
					event.preventDefault();
					activate(next, true);
				});
			});

			activate(0);
		});
	}
</script>

{#if isEmpty}
	{@render children?.()}
{:else}
	<article
		bind:this={articleEl}
		class={cn(
			prose && 'prose max-w-none',
			'markdown-body',
			'[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted/50 [&_pre]:p-4',
			'[&_code]:rounded [&_code]:bg-muted/50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm',
			'[&_pre_code]:bg-transparent [&_pre_code]:p-0',
			'[&_table]:block [&_table]:w-full [&_table]:overflow-x-auto',
			'[&_img]:max-w-full [&_img]:rounded-lg',
			'[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_blockquote]:italic',
			'[&_ul]:list-disc [&_ul]:pl-6',
			'[&_ol]:list-decimal [&_ol]:pl-6',
			'[&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden',
			'[&_.katex]:text-base',
			'[&_.mermaid]:rounded-lg [&_.mermaid]:bg-muted/30 [&_.mermaid]:p-4',
			className
		)}
	>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- Safe: HTML is sanitized by rehype-sanitize -->
		{@html renderedHtml}
	</article>
{/if}
