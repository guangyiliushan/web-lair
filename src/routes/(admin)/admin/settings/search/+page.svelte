<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
</script>

<svelte:head>
	<title>{m.admin_settings_search_push()} - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2">
			<IconDeviceFloppy class="size-4 shrink-0 text-muted-foreground" />
			<h2 class="truncate text-sm font-semibold">{m.admin_settings_search_push()}</h2>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button size="sm">
				<IconDeviceFloppy data-icon="inline-start" />
				{m.admin_common_save()}
			</Button>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-auto">
		<div class="space-y-8 p-6">
			<!-- Baidu 推送 -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_search_baidu()}</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- baiduEnabled -->
					<div class="flex items-center justify-between gap-4">
						<label for="search-baiduEnabled" class="text-sm"
							>{m.admin_settings_search_baidu_enabled()}</label
						>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.search.baiduEnabled)}
							aria-label={m.admin_settings_search_baidu_enabled()}
							id="search-baiduEnabled"
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.search.baiduEnabled}
							class:bg-surface-inset={!s.search.baiduEnabled}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.search.baiduEnabled}
							></span>
						</button>
					</div>

					<!-- baiduToken -->
					<div class="space-y-1.5">
						<label for="search-baiduToken" class="text-sm"
							>{m.admin_settings_search_baidu_token()}</label
						>
						<Input
							id="search-baiduToken"
							type="password"
							bind:value={s.search.baiduToken}
							placeholder={m.admin_settings_search_baidu_token_ph()}
						/>
					</div>
				</div>
			</section>

			<!-- Bing 推送 -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_search_bing()}</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- bingEnabled -->
					<div class="flex items-center justify-between gap-4">
						<label for="search-bingEnabled" class="text-sm"
							>{m.admin_settings_search_bing_enabled()}</label
						>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.search.bingEnabled)}
							aria-label={m.admin_settings_search_bing_enabled()}
							id="search-bingEnabled"
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.search.bingEnabled}
							class:bg-surface-inset={!s.search.bingEnabled}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.search.bingEnabled}
							></span>
						</button>
					</div>

					<!-- bingApiKey -->
					<div class="space-y-1.5">
						<label for="search-bingApiKey" class="text-sm">Bing API Key</label>
						<Input
							id="search-bingApiKey"
							type="password"
							bind:value={s.search.bingApiKey}
							placeholder="Bing Webmaster API Key"
						/>
					</div>
				</div>
			</section>
		</div>
	</div>
</div>
