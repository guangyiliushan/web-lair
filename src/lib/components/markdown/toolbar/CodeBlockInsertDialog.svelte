<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import { m } from '$lib/paraglide/messages';
	import { CODE_LANGUAGES } from './code-languages';

	let {
		open = $bindable(),
		onInsert
	}: {
		open: boolean;
		onInsert: (language: string) => void;
	} = $props();

	let query = $state('');

	// reset the search whenever the dialog opens (mirrors ImageInsertDialog)
	$effect(() => {
		if (open) query = '';
	});

	function pick(language: string) {
		onInsert(language);
		open = false;
	}

	// The free-form entry appears only when nothing else matches: any
	// identifier is a valid fence language (spec 3.3).
	const showCustom = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return q.length > 0 && !CODE_LANGUAGES.some((language) => language.includes(q));
	});
</script>

<Command.Dialog bind:open title={m.code_block_title()} description={m.code_block_description()}>
	<!-- the search text lives on Command.Input (the root's `value` is the
	     selected item, not the query) -->
	<Command.Input bind:value={query} placeholder={m.code_block_search()} />
	<Command.List>
		<Command.Empty>{m.code_block_empty()}</Command.Empty>
		<Command.Group heading={m.code_block_group_plaintext()}>
			<Command.Item value="plaintext" onSelect={() => pick('')}>
				{m.code_block_plaintext()}
			</Command.Item>
		</Command.Group>
		<Command.Group heading={m.code_block_group_languages()}>
			{#each CODE_LANGUAGES as language (language)}
				<Command.Item value={language} onSelect={() => pick(language)}>{language}</Command.Item>
			{/each}
		</Command.Group>
		{#if showCustom}
			<Command.Group heading={m.code_block_group_custom()}>
				<Command.Item value={query.trim()} onSelect={() => pick(query.trim())}>
					{m.code_block_use_custom({ language: query.trim() })}
				</Command.Item>
			</Command.Group>
		{/if}
	</Command.List>
</Command.Dialog>
