<script lang="ts">
	import { m } from '$lib/paraglide/messages';
</script>

<svelte:head>
	<title>{m.admin_debug_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-4">
	<div>
		<h2 class="text-2xl font-semibold tracking-tight">{m.admin_debug_title()}</h2>
		<p class="text-sm text-muted-foreground">{m.admin_debug_desc()}</p>
	</div>
	<div class="rounded-xl border bg-background p-6">
		<p class="text-sm text-muted-foreground">{m.admin_debug_placeholder()}</p>
	</div>
</div>
