<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { Empty } from '$lib/components/ui/empty';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
</script>

<div class="flex h-full items-center justify-center">
	<Empty>
		<div class="flex flex-col items-center gap-1">
			<IconTag class="size-8 text-muted-foreground/40" />
			<h3 class="text-lg font-semibold tracking-tight">{m.admin_tags_select()}</h3>
			<p class="text-sm text-muted-foreground">{m.admin_tags_select_hint()}</p>
		</div>
	</Empty>
</div>
