<script lang="ts">
	import * as InputGroup from '$lib/components/ui/input-group';
	import { m } from '$lib/paraglide/messages';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconPaperclip from '@tabler/icons-svelte-runes/icons/paperclip';

	let { disabled = false }: { disabled?: boolean } = $props();
</script>

<div class="shrink-0 border-t bg-background px-3 pt-2 pb-3 sm:px-4">
	<form
		class="mx-auto flex w-full max-w-3xl flex-col gap-1.5"
		onsubmit={(event) => event.preventDefault()}
	>
		<InputGroup.Root class="rounded-3xl bg-background">
			<InputGroup.Textarea
				aria-label={m.admin_ai_composer_placeholder()}
				placeholder={m.admin_ai_composer_placeholder()}
				rows={1}
				{disabled}
				class="min-h-14 px-3.5 pt-3 pb-1 text-sm"
			/>
			<InputGroup.Addon align="block-end" class="gap-1 px-2.5 pb-2">
				<InputGroup.Button
					variant="ghost"
					size="icon-sm"
					{disabled}
					aria-label={m.admin_ai_attach()}
					title={m.admin_ai_attach()}
				>
					<IconPaperclip />
				</InputGroup.Button>
				<span class="min-w-0 flex-1 truncate px-1 text-[11px] text-muted-foreground">
					{disabled ? m.admin_ai_composer_hint() : ''}
				</span>
				<InputGroup.Button
					size="icon-sm"
					class="rounded-full"
					{disabled}
					aria-label={m.admin_ai_send()}
					title={m.admin_ai_send()}
				>
					<IconArrowUp />
				</InputGroup.Button>
			</InputGroup.Addon>
		</InputGroup.Root>
	</form>
</div>
