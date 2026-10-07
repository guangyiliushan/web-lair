<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import { type MomentKind } from '$lib/utils/moment-meta';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconThumbUp from '@tabler/icons-svelte-runes/icons/thumb-up';
	import IconThumbDown from '@tabler/icons-svelte-runes/icons/thumb-down';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const kindLabels: Record<MomentKind, () => string> = {
		life: m.moments_kind_life,
		tech: m.moments_kind_tech,
		media: m.moments_kind_media,
		other: m.moments_kind_other
	};
</script>

<svelte:head>
	<title>{data.title}</title>
</svelte:head>

<SeoHead path={`/moments/${data.row.id}`} />

<article class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0">
	<a
		href={siteHref('/moments')}
		class="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
	>
		<IconArrowLeft class="size-3.5" />
		{m.moments_back()}
	</a>

	<div class="mt-10">
		<p class="text-xl leading-relaxed wrap-break-word whitespace-pre-wrap">{data.row.content}</p>
		<div class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
			<span class="rounded border px-1.5 py-0.5 text-xs">
				{kindLabels[data.row.type as MomentKind]?.() ?? data.row.type}
			</span>
			<time>{data.row.dateLabel}</time>
			<span
				class="inline-flex items-center gap-2"
				aria-label={`${m.moments_vote_up()} / ${m.moments_vote_down()}`}
			>
				<span class="inline-flex items-center gap-1">
					<IconThumbUp class="size-4" />
					{data.row.up}
				</span>
				<span class="h-3 w-px bg-border"></span>
				<span class="inline-flex items-center gap-1">
					<IconThumbDown class="size-4" />
					{data.row.down}
				</span>
			</span>
		</div>
	</div>
</article>
