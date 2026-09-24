<script lang="ts">
	import type { PageProps } from './$types';
	import { Input } from '$lib/components/ui/input';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
</script>

<svelte:head>
	<title>System 设定 - Lair Admin</title>
</svelte:head>

<div class="space-y-10">
	<section class="space-y-4">
		<header>
			<h2 class="inline-flex items-center gap-2 text-base font-medium">Admin extras</h2>
		</header>
		<div class="space-y-5">
			<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
				<div class="md:pt-1.5">
					<div class="text-sm">Enable admin reverse proxy</div>
					<p class="mt-1 text-xs leading-5 text-muted-foreground">
						Whether the admin dashboard can be accessed through the API
					</p>
				</div>
				<div class="md:flex md:justify-end md:pt-1">
					<button
						type="button"
						role="switch"
						aria-checked={s.system.adminProxy}
						aria-label="切换"
						class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
						class:bg-accent={s.system.adminProxy}
						class:bg-surface-inset={!s.system.adminProxy}
					>
						<span
							class="block size-4 rounded-full bg-white shadow-xs transition-transform"
							class:translate-x-4={s.system.adminProxy}
						></span>
					</button>
				</div>
			</div>
			<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
				<div class="md:pt-1.5"><div class="text-sm">Login page background</div></div>
				<div class="min-w-0"><Input type="text" value={s.system.loginBg} /></div>
			</div>
			<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
				<div class="md:pt-1.5">
					<div class="text-sm">Amap query API key</div>
					<p class="mt-1 text-xs leading-5 text-muted-foreground">
						Location lookup for diary entries
					</p>
				</div>
				<div class="min-w-0"><Input type="password" value={s.system.amapKey} /></div>
			</div>
		</div>
	</section>

	<section class="space-y-4">
		<header>
			<h2 class="inline-flex items-center gap-2 text-base font-medium">Feature toggles</h2>
		</header>
		<div class="space-y-5">
			<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
				<div class="md:pt-1.5"><div class="text-sm">Enable email subscription</div></div>
				<div class="md:flex md:justify-end md:pt-1">
					<button
						type="button"
						role="switch"
						aria-checked={s.system.emailSubscription}
						aria-label="切换"
						class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
						class:bg-accent={s.system.emailSubscription}
						class:bg-surface-inset={!s.system.emailSubscription}
					>
						<span
							class="block size-4 rounded-full bg-white shadow-xs transition-transform"
							class:translate-x-4={s.system.emailSubscription}
						></span>
					</button>
				</div>
			</div>
		</div>
	</section>
</div>
