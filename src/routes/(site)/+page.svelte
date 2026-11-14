<script lang="ts">
	import Hero from './Hero.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Hero links={data.ownerLinks} />

<div id="content" class="mx-auto flex max-w-4xl flex-col gap-24 px-4 py-16 sm:px-6 lg:px-8">
	<div class="flex flex-col gap-4">
		<h2 class="text-2xl font-bold">What is SvelteKit?</h2>
		<p class="text-lg">
			SvelteKit is a new framework for building web applications. It's built on top of Svelte, a new
			kind of component framework.
		</p>
	</div>
</div>
