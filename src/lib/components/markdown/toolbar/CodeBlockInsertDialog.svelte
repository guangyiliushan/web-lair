<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import { m } from '$lib/paraglide/messages';
	import { CODE_LANGUAGES, sanitizeLanguage } from './code-languages';

	let {
		open = $bindable(),
		onInsert
	}: {
		open: boolean;
		onInsert: (language: string) => void;
	} = $props();

	let query = $state('');

	function reset() {
		query = '';
	}

	// Reset through the CLOSE path (escape / overlay / close button / pick):
	// bits-ui only fires onOpenChange for its own close paths, never for a
	// programmatic open from the toolbar, so an open-side reset would be dead
	// code. Still callback-driven — the Svelte docs discourage state updates
	// inside effects.
	function handleOpenChange(next: boolean) {
		if (!next) reset();
	}

	function pick(language: string) {
		onInsert(language);
		reset();
		open = false;
	}

	// The free-form entry appears only when nothing else matches: any
	// identifier is a valid fence language (spec 3.3), but it must survive as
	// a single info token — sanitize before offering it. The guard mirrors the
	// actual command filter below (same substring predicate), so the entry can
	// never be hidden while nothing else matches.
	const customLanguage = $derived(sanitizeLanguage(query));
	const showCustom = $derived(
		query.trim().length > 0 &&
			!CODE_LANGUAGES.some((language) =>
				language.toLowerCase().includes(query.trim().toLowerCase())
			)
	);
</script>

<Command.Dialog
	bind:open
	onOpenChange={handleOpenChange}
	filter={(value, search) => (value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}
	title={m.code_block_title()}
	description={m.code_block_description()}
>
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
				<!-- value keeps the raw query so the built-in filter matches it;
				     the inserted language is the sanitised form shown in the text -->
				<Command.Item value={query.trim()} onSelect={() => pick(customLanguage)}>
					{m.code_block_use_custom({ language: customLanguage })}
				</Command.Item>
			</Command.Group>
		{/if}
	</Command.List>
</Command.Dialog>
