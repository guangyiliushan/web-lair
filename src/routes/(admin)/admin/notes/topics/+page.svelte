<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { Empty } from '$lib/components/ui/empty';
	import IconBulb from '@tabler/icons-svelte-runes/icons/bulb';
</script>

<div class="flex h-full items-center justify-center">
	<Empty>
		<div class="flex flex-col items-center gap-1">
			<IconBulb class="size-8 text-muted-foreground/40" />
			<h3 class="text-lg font-semibold tracking-tight">{m.admin_notes_topics_select()}</h3>
			<p class="text-sm text-muted-foreground">{m.admin_notes_topics_select_desc()}</p>
		</div>
	</Empty>
</div>
