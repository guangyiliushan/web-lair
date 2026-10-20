<script lang="ts">
	import { CommentsSection, SegmentCommentLayer } from '$lib/components/comments';
	import { MarkdownRenderer } from '$lib/components/markdown';
	import { PostTranslationMenu } from '$lib/components/posts';
	import { ContentPresence } from '$lib/components/presence';
	import { SeoHead } from '$lib/components/seo';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';
	import { IconEye, IconHeart, IconSparkles } from '@tabler/icons-svelte-runes';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Segment comments need the live article root (selection -> anchor).
	let articleHost = $state<HTMLElement | null>(null);

	function writingText(origin: string | null | undefined): string {
		switch (origin) {
			case 'none':
				return m.post_provenance_writing_none();
			case 'assist':
				return m.post_provenance_writing_assist();
			case 'mostly_ai':
				return m.post_provenance_writing_mostly();
			case 'ai_full':
				return m.post_provenance_writing_full();
			default:
				return m.post_provenance_writing_undisclosed();
		}
	}

	function visualText(origin: string | null | undefined): string {
		switch (origin) {
			case 'none':
				return m.post_provenance_visual_none();
			case 'some':
				return m.post_provenance_visual_some();
			case 'all':
				return m.post_provenance_visual_all();
			case null:
			case undefined:
				return m.post_provenance_visual_undisclosed();
			default:
				return m.post_provenance_visual_undisclosed();
		}
	}

	function translationText(
		origin: string | null | undefined,
		isTranslation: boolean
	): string | null {
		if (!isTranslation) return null;
		switch (origin) {
			case 'ai':
				return m.post_provenance_translation_ai();
			case 'machine':
				return m.post_provenance_translation_machine();
			case 'human':
				return m.post_provenance_translation_human();
			default:
				return m.post_provenance_translation_undisclosed();
		}
	}

	// The AI trigger is always rendered: an undisclosed post must say so
	// (null ≠ none), and the disclosure value is the button's accessible name.
</script>

<svelte:head>
	<title>{data.post.title}</title>
</svelte:head>

<SeoHead path={data.seo.path} alternates={data.seo.alternates} />

<article class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0">
	<header class="relative border-b border-border/50 pb-6">
		<h1 class="text-center text-3xl font-normal">{data.post.title}</h1>
		<div
			data-testid="post-detail-meta"
			class="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
		>
			<span
				data-testid="post-detail-date"
				class="flex basis-full items-center justify-center gap-x-2 whitespace-nowrap md:basis-auto"
			>
				<span>{data.post.date}</span>
				{#if data.post.edited}
					<span class="flex items-center gap-x-2">
						<span aria-hidden="true">·</span>
						<span>edited</span>
					</span>
				{/if}
			</span>

			<!-- Taxonomy: its own full-width row on mobile, inline from md up. -->
			<span
				data-testid="post-detail-tags"
				class="order-last flex min-w-0 basis-full items-center justify-center gap-x-2 md:order-none md:basis-auto"
			>
				<span aria-hidden="true" class="hidden shrink-0 md:inline">·</span>
				<span class="min-w-0 truncate">
					<span class="text-primary-text">{data.post.category}</span>
					{#each data.post.tags as tag, i (tag)}<span>{i === 0 ? ' / ' : ', '}</span><span
							class="text-primary-text">{tag}</span
						>{/each}
				</span>
			</span>

			<!-- Stats + provenance: one row of their own on mobile, inline from md up. -->
			<span
				data-testid="post-detail-stats"
				class="flex basis-full flex-wrap items-center justify-center gap-x-2 gap-y-1 md:basis-auto"
			>
				<span class="flex items-center gap-x-2 whitespace-nowrap">
					<span aria-hidden="true" class="hidden md:inline">·</span>
					<span data-testid="post-views" class="inline-flex items-center gap-1 tabular-nums">
						<IconEye class="size-3.5" />
						<span>{data.post.views}</span>
						<span class="hidden sm:inline">reads</span>
					</span>
				</span>
				<span class="flex items-center gap-x-2 whitespace-nowrap">
					<span aria-hidden="true">·</span>
					<span data-testid="post-likes" class="inline-flex items-center gap-1 tabular-nums">
						<IconHeart class="size-3.5" />
						<span>{data.post.likes}</span>
						<span class="hidden sm:inline">likes</span>
					</span>
				</span>
				{#key data.post.id}
					<ContentPresence contentId={data.post.id} config={data.presence} strip={false} />
				{/key}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								data-testid="post-ai-trigger"
								type="button"
								class="inline-flex items-center gap-1 rounded-sm whitespace-nowrap transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground"
								aria-label={m.post_provenance_show_disclosure({
									label: writingText(data.provenance.writingOrigin)
								})}
							>
								<IconSparkles class="size-3.5" />
								<span>{writingText(data.provenance.writingOrigin)}</span>
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content
						data-testid="post-ai-card"
						side="bottom"
						class="pointer-events-none w-80 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-2 rounded-lg border border-border bg-card p-3 text-left text-xs text-card-foreground shadow-lg"
					>
						<div class="flex flex-col gap-1">
							<strong class="font-medium">{m.post_provenance_tooltip_writing()}</strong>
							<span class="text-muted-foreground">
								{writingText(data.provenance.writingOrigin)}
								{#if data.provenance.aiHelp?.length}
									{m.post_provenance_ai_helped({ items: data.provenance.aiHelp.join(', ') })}
								{/if}
							</span>
						</div>
						<div class="flex flex-col gap-1">
							<strong class="font-medium">{m.post_provenance_tooltip_visuals()}</strong>
							<span class="text-muted-foreground">{visualText(data.provenance.visualOrigin)}</span>
						</div>
					</Tooltip.Content>
				</Tooltip.Root>
				{#if data.provenance.isTranslation && data.provenance.translationOrigin}
					<span data-testid="post-translation" class="hidden whitespace-nowrap md:inline">
						{translationText(data.provenance.translationOrigin, true)}
					</span>
				{/if}
				{#if data.post.translations.length > 1}
					<PostTranslationMenu translations={data.post.translations} current={data.post.lang} />
				{/if}
			</span>
		</div>
	</header>

	<div class="mt-8" bind:this={articleHost}>
		<MarkdownRenderer html={data.html} prose />
	</div>

	{#if data.discussion && articleHost}
		<SegmentCommentLayer
			container={articleHost}
			threads={data.discussion}
			canComment={data.viewer.canComment}
			loginUrl={data.viewer.loginUrl}
			form={form ?? null}
		/>
	{/if}

	{#if data.discussion}
		<CommentsSection
			targetType="post"
			threads={data.discussion}
			canComment={data.viewer.canComment}
			emailVerified={data.viewer.emailVerified}
			loginUrl={data.viewer.loginUrl}
			form={form ?? null}
		/>
	{/if}

	<footer class="mt-16 border-t border-border/40 pt-5">
		<a
			href={localizeHref('/posts')}
			class="text-xs font-medium tracking-[2.5px] text-muted-foreground uppercase transition-colors hover:text-primary-text"
		>
			← Back to posts
		</a>
	</footer>
</article>
