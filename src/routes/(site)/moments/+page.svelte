<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import { MOMENT_KINDS, type MomentKind } from '$lib/utils/moment-meta';
	import IconWriting from '@tabler/icons-svelte-runes/icons/writing';
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

	const chipBase = 'rounded-full px-3 py-1 text-xs whitespace-nowrap transition-colors';
	const chipActive = `${chipBase} bg-primary/10 text-primary`;
	const chipIdle = `${chipBase} text-muted-foreground hover:bg-muted hover:text-foreground`;
</script>

<SeoHead path="/moments" />

<div class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0">
	<div class="min-w-0">
		<h1 class="text-[28px] leading-tight font-medium">{m.moments_title()}</h1>
		<p class="mt-2 text-sm text-muted-foreground">{m.moments_subtitle()}</p>
		<div class="mt-6 mb-4 h-px w-8 bg-primary/70"></div>

		<div class="flex flex-wrap gap-1.5" role="group" aria-label={m.moments_kind_all()}>
			<a
				href={siteHref('/moments')}
				class={!data.kind ? chipActive : chipIdle}
				aria-current={!data.kind ? 'true' : undefined}
			>
				{m.moments_kind_all()}
			</a>
			{#each MOMENT_KINDS as kind (kind)}
				<a
					href={siteHref(`/moments?kind=${kind}`)}
					class={data.kind === kind ? chipActive : chipIdle}
					aria-current={data.kind === kind ? 'true' : undefined}
				>
					{kindLabels[kind]()}
				</a>
			{/each}
		</div>
	</div>

	{#await data.rows}
		<div class="flex flex-col gap-4 py-6" aria-hidden="true">
			{#each [0, 1, 2, 3] as i (i)}
				<Skeleton class="h-20 w-full" />
			{/each}
		</div>
	{:then rows}
		{#if rows.length === 0}
			<p class="py-6 text-sm text-muted-foreground">{m.moments_empty()}</p>
		{:else}
			<div class="flex flex-col gap-4 py-6">
				{#each rows as row (row.id)}
					<article
						class="rounded-lg border border-border/60 p-4 transition-colors hover:border-border hover:bg-muted/30"
					>
						<a href={siteHref(`/moments/${row.id}`)} class="block">
							<div class="flex items-start gap-3">
								<IconWriting class="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
								<div class="min-w-0 flex-1">
									<p class="text-base leading-7 wrap-break-word whitespace-pre-wrap">
										{row.content}
									</p>
									<div
										class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
									>
										<span class="rounded border px-1.5 py-0.5">
											{kindLabels[row.type as MomentKind]?.() ?? row.type}
										</span>
										<time>{row.dateLabel}</time>
										<span class="inline-flex items-center gap-2">
											<span class="inline-flex items-center gap-1">
												<IconThumbUp class="size-3.5" />
												{row.up}
											</span>
											<span class="h-3 w-px bg-border"></span>
											<span class="inline-flex items-center gap-1">
												<IconThumbDown class="size-3.5" />
												{row.down}
											</span>
										</span>
									</div>
								</div>
							</div>
						</a>
					</article>
				{/each}
			</div>
		{/if}
	{/await}
</div>
