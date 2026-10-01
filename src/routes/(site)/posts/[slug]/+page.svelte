<script lang="ts">
	import { CommentsSection } from '$lib/components/comments';
	import { MarkdownRenderer } from '$lib/components/markdown';
	import { SeoHead } from '$lib/components/seo';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.post.title}</title>
</svelte:head>

<SeoHead path={data.seo.path} alternates={data.seo.alternates} />

<article class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0">
	<header class="border-b border-border/50 pb-6">
		<h1 class="text-3xl font-normal">{data.post.title}</h1>
		<div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
			<span class="whitespace-nowrap">{data.post.date}</span>
			<span class="text-muted-foreground/40">·</span>
			<span class="text-primary">{data.post.category}</span>
		</div>
	</header>

	<div class="mt-8">
		<MarkdownRenderer html={data.html} prose />
	</div>

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
			class="text-xs font-medium tracking-[2.5px] text-muted-foreground uppercase transition-colors hover:text-primary"
		>
			← Back to posts
		</a>
	</footer>
</article>
