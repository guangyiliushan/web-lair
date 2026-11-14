<script lang="ts">
	import Hero from './Hero.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Hero owner={data.owner} links={data.ownerLinks} hero={data.hero} />
