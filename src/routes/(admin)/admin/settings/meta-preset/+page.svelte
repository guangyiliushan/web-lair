<script lang="ts">
	import type { PageProps } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import IconList from '@tabler/icons-svelte-runes/icons/list';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
</script>

<div class="space-y-6">
	<section>
		<div class="mb-4 flex items-center justify-between">
			<div class="flex items-center gap-2">
				<IconList class="size-5 text-muted-foreground" />
				<div>
					<h3 class="text-base font-semibold">Meta 预设字段</h3>
					<p class="text-xs text-muted-foreground">
						管理文章元数据字段的预设模板，控制各字段的启用状态
					</p>
				</div>
			</div>
			<Button variant="outline" size="sm">
				<IconPlus data-icon="inline-start" />
				新增预设
			</Button>
		</div>

		<div class="space-y-3">
			{#each s.metaPreset as preset (preset.key)}
				<div class="flex items-start gap-3 rounded-lg border bg-background p-3">
					<div class="mt-0.5 shrink-0">
						{#if preset.builtin}
							<IconLock class="size-4 text-muted-foreground" />
						{:else}
							<IconList class="size-4 text-muted-foreground" />
						{/if}
					</div>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-1.5">
							<span class="truncate text-sm font-medium">{preset.label}</span>
							<code class="truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
								{preset.key}
							</code>
							<Badge variant="secondary">{preset.type}</Badge>
							<Badge variant="outline">{preset.scope}</Badge>
							{#if preset.builtin}
								<Badge variant="secondary" class="text-xs">内置</Badge>
							{/if}
						</div>
						{#if preset.description}
							<p class="mt-1 text-xs text-muted-foreground">{preset.description}</p>
						{/if}
					</div>
					<div class="shrink-0">
						<label class="relative inline-flex cursor-pointer items-center">
							<input type="checkbox" class="peer sr-only" bind:checked={preset.enabled} />
							<div
								class="h-5 w-9 rounded-full bg-border transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50"
							></div>
							<div
								class="absolute inset-s-1 size-3.5 rounded-full bg-background shadow-sm transition-transform peer-checked:translate-x-4"
							></div>
						</label>
					</div>
				</div>
			{/each}
		</div>
	</section>
</div>
