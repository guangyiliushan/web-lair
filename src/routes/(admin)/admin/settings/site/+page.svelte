<script lang="ts">
	import type { PageProps } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
</script>

<svelte:head>
	<title>Site 设定 - Lair Admin</title>
</svelte:head>

<div class="space-y-10">
	<section class="space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="inline-flex items-center gap-2 text-base font-medium">Site URLs</h2>
			</div>
		</header>
		<div class="space-y-5">
			{#each [['Frontend URL', 'frontendUrl'], ['Admin dashboard URL', 'adminUrl'], ['API URL', 'apiUrl'], ['Gateway URL', 'gatewayUrl']] as [label, key] (key)}
				<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
					<div class="md:pt-1.5"><div class="text-sm">{label}</div></div>
					<div class="min-w-0">
						<Input type="text" value={s.site[key as keyof typeof s.site] as string} />
					</div>
				</div>
			{/each}
		</div>
	</section>
	<section class="space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="inline-flex items-center gap-2 text-base font-medium">SEO</h2>
			</div>
		</header>
		<div class="space-y-5">
			{#each [['Site title', 'title'], ['Site description', 'description'], ['Light icon URL', 'lightIcon'], ['Dark icon URL', 'darkIcon']] as [label, key] (key)}
				<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
					<div class="md:pt-1.5"><div class="text-sm">{label}</div></div>
					<div class="min-w-0">
						<Input type="text" value={s.site[key as keyof typeof s.site] as string} />
					</div>
				</div>
			{/each}
			<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
				<div class="md:pt-1.5"><div class="text-sm">Keywords</div></div>
				<div class="min-w-0">
					<div class="space-y-2">
						<div class="flex flex-wrap gap-2">
							{#each s.site.keywords as kw (kw)}
								<Badge variant="secondary" class="gap-1">
									{kw}
									<button
										type="button"
										class="inline-flex size-3 items-center"
										aria-label="移除 {kw}"><IconX class="size-3" /></button
									>
								</Badge>
							{/each}
						</div>
						<Input type="text" placeholder="输入后按 Enter" />
					</div>
				</div>
			</div>
		</div>
	</section>
	<div class="flex justify-end">
		<Button type="button" size="sm">
			<IconDeviceFloppy data-icon="inline-start" />
			保存
		</Button>
	</div>
</div>
