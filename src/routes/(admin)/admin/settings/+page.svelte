<script lang="ts">
	import { Empty } from '$lib/components/ui/empty';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import { m } from '$lib/paraglide/messages';
</script>

<div class="hidden flex-1 items-center justify-center sm:flex">
	<Empty>
		<div class="flex flex-col items-center gap-1">
			<IconSettings class="size-8 text-muted-foreground/40" />
			<h3 class="text-lg font-semibold tracking-tight">{m.admin_settings_title()}</h3>
			<p class="text-sm text-muted-foreground">{m.admin_settings_select_hint()}</p>
		</div>
	</Empty>
</div>
