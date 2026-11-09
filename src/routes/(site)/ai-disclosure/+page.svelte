<script lang="ts">
	import { m } from '$lib/paraglide/messages';
</script>

<svelte:head>
	<title>{m.ai_disclosure_title()}</title>
</svelte:head>

<article class="mx-auto max-w-3xl px-4 py-16">
	<h1 class="text-2xl font-semibold tracking-tight">{m.ai_disclosure_title()}</h1>
	<p class="mt-4 text-sm leading-relaxed text-muted-foreground">{m.ai_disclosure_intro()}</p>

	<ul class="mt-6 flex flex-col gap-3 text-sm">
		<li><strong class="font-medium">{m.ai_disclosure_assist()}</strong></li>
		<li><strong class="font-medium">{m.ai_disclosure_mostly_ai()}</strong></li>
		<li><strong class="font-medium">{m.ai_disclosure_ai_full()}</strong></li>
	</ul>

	<p class="mt-6 text-xs leading-relaxed text-muted-foreground">{m.ai_disclosure_policy()}</p>
</article>
