<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { m } from '$lib/paraglide/messages';

	/**
	 * One-value prompt shared by the inserts that need a short answer
	 * (mention handle, footnote text, card URL).
	 *
	 * `window.prompt` is unusable here: it is unavailable in embedded
	 * browsers/automation (the link insert already retired it) and it steals
	 * the editing context. This keeps the same one-field flow on shadcn
	 * primitives instead of one bespoke dialog per insert.
	 */
	let {
		open = $bindable(),
		title,
		label,
		hint,
		placeholder,
		onSubmit
	}: {
		open: boolean;
		title: string;
		label: string;
		hint?: string;
		placeholder?: string;
		onSubmit: (value: string) => void;
	} = $props();

	let value = $state('');

	// Reset only through the CLOSE path (escape / overlay / cancel / submit):
	// bits-ui fires onOpenChange for its own close paths, never for a
	// programmatic open from the toolbar (same contract as CodeBlockInsertDialog).
	function handleOpenChange(next: boolean) {
		if (!next) value = '';
	}

	function submit() {
		const trimmed = value.trim();
		if (!trimmed) return;
		onSubmit(trimmed);
		value = '';
		open = false;
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-sm">
			<Dialog.Header>
				<Dialog.Title>{title}</Dialog.Title>
			</Dialog.Header>
			<form
				class="flex flex-col gap-2 px-6 pb-2"
				onsubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<Field.Field>
					<Field.Label for="value-prompt-input">{label}</Field.Label>
					<Input
						id="value-prompt-input"
						bind:value
						{placeholder}
						autocomplete="off"
						data-testid="value-prompt-input"
					/>
					{#if hint}
						<Field.Description>{hint}</Field.Description>
					{/if}
				</Field.Field>
				<Dialog.Footer>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button type="button" variant="outline" {...props}>{m.admin_common_cancel()}</Button>
						{/snippet}
					</Dialog.Close>
					<Button type="submit" disabled={!value.trim()}>{m.admin_common_confirm()}</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
