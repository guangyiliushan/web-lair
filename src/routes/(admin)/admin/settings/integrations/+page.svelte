<script lang="ts">
	import type { PageProps } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
</script>

a

<svelte:head>
	<title>第三方集成 - Lair Admin</title>
</svelte:head>

<div class="space-y-10">
	<section class="space-y-4">
		<header>
			<h2 class="inline-flex items-center gap-2 text-base font-medium">Third-party integrations</h2>
		</header>
		<div class="space-y-5">
			{#each [['GitHub', 'github', true, 'Personal Access Token', 'Used when calling the GitHub API; fill in when you hit rate limits'], ['TMDB', 'tmdb', true, 'API Key', ''], ['Bangumi', 'bangumi', true, 'Access Token', ''], ['NeoDB', 'neodb', false, '', ''], ['Arxiv', 'arxiv', false, '', ''], ['Leetcode', 'leetcode', false, '', ''], ['NetEase Cloud Music', 'neteaseMusic', false, '', ''], ['QQ Music', 'qqMusic', false, '', '']] as [label, id, hasToken, tokenLabel, tokenDesc] (id)}
				{@const integration = s.integrations[id as keyof typeof s.integrations]}
				<section class="space-y-3">
					<h4 class="text-xs font-semibold text-muted-foreground uppercase">{label}</h4>
					<div class="space-y-5">
						<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
							<div class="md:pt-1.5"><div class="text-sm">Enabled</div></div>
							<div class="md:flex md:justify-end md:pt-1">
								<button
									type="button"
									role="switch"
									aria-checked={integration.enabled}
									aria-label="切换"
									class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
									class:bg-accent={integration.enabled}
									class:bg-surface-inset={!integration.enabled}
								>
									<span
										class="block size-4 rounded-full bg-white shadow-xs transition-transform"
										class:translate-x-4={integration.enabled}
									></span>
								</button>
							</div>
						</div>
						{#if hasToken}
							<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
								<div class="md:pt-1.5">
									<div class="text-sm">{tokenLabel}</div>
									{#if tokenDesc}<p class="mt-1 text-xs leading-5 text-muted-foreground">
											{tokenDesc}
										</p>{/if}
								</div>
								<div class="min-w-0"><Input type="password" /></div>
							</div>
						{/if}
					</div>
				</section>
			{/each}
		</div>
	</section>
</div>
