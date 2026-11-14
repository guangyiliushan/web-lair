<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	let {
		children,
		class: className
	}: {
		children: Snippet;
		class?: string;
	} = $props();
</script>

<!-- Single fixed card shared by the site, gallery and viewer chrome. The
     shell deliberately does not clip its children: desktop nav panels hang
     below the bar, while the mobile accordion owns its own clip. -->
<header class="pointer-events-none fixed top-6 right-0 left-0 z-50 flex justify-center px-4">
	<div
		data-slot="site-header-bar"
		class={cn(
			'@container pointer-events-auto w-full max-w-5xl rounded-3xl border bg-background/70 shadow-sm backdrop-blur-md',
			className
		)}
	>
		{@render children()}
	</div>
</header>
