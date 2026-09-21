<script lang="ts">
	import { onMount } from 'svelte';
	import { createEditor, $getNodeByKey as getLexicalNodeByKey, type LexicalEditor } from 'lexical';
	import { registerRichText } from '@lexical/rich-text';
	import { registerHistory, createEmptyHistoryState } from '@lexical/history';
	import { EDITOR_THEME, NESTED_EDITOR_NODES } from '$lib/components/markdown/editor/editor-shared';
	import {
		rememberDecoratorFocus,
		shouldRestoreDecoratorFocus
	} from '$lib/components/markdown/editor/decorator-focus';
	import { DetailsNode } from './details-node';

	type Props = {
		nodeKey: string;
		variant: 'details' | 'spoiler';
		summary: string;
		open: boolean;
		initialContent: string;
		parentEditor: LexicalEditor;
	};

	let { nodeKey, variant, summary, open, initialContent, parentEditor }: Props = $props();

	const SYNC_DEBOUNCE_MS = 400;

	let nestedEditor: LexicalEditor | null = null;
	let contentEl: HTMLElement | undefined;
	let syncTimer: ReturnType<typeof setTimeout> | null = null;
	let isCleaned = false;

	function cleanup() {
		if (isCleaned) return;
		isCleaned = true;
		if (syncTimer) clearTimeout(syncTimer);
		unregisterUpdate?.();
		unregisterMutation?.();
		nestedEditor?.setRootElement(null);
	}

	let unregisterUpdate: (() => void) | undefined;
	let unregisterMutation: (() => void) | undefined;

	function toggleOpen() {
		parentEditor.update(() => {
			const node = getLexicalNodeByKey(nodeKey);
			if (node instanceof DetailsNode) node.setOpen(!node.isOpen());
		});
	}

	onMount(() => {
		nestedEditor = createEditor({
			namespace: 'details-nested',
			nodes: NESTED_EDITOR_NODES,
			theme: EDITOR_THEME,
			onError: (error: Error) => console.error('Details nested editor error:', error)
		});

		if (!contentEl) return;
		nestedEditor.setRootElement(contentEl);
		nestedEditor.setEditable(true);
		if (shouldRestoreDecoratorFocus(nodeKey)) contentEl.focus();
		registerRichText(nestedEditor);
		registerHistory(nestedEditor, createEmptyHistoryState(), 300);

		try {
			nestedEditor.setEditorState(nestedEditor.parseEditorState(initialContent));
		} catch (error) {
			console.error('Details nested editor: failed to parse initial content', error);
		}

		// child → parent: write the body JSON back with a debounce
		unregisterUpdate = nestedEditor.registerUpdateListener(({ editorState }) => {
			if (syncTimer) clearTimeout(syncTimer);
			syncTimer = setTimeout(() => {
				const json = JSON.stringify(editorState.toJSON());
				parentEditor.update(() => {
					const node = getLexicalNodeByKey(nodeKey);
					if (node instanceof DetailsNode) node.setJsonContent(json);
				});
			}, SYNC_DEBOUNCE_MS);
		});

		// parent → child / hard cleanup
		unregisterMutation = parentEditor.registerMutationListener(DetailsNode, (mutations) => {
			const mutation = mutations.get(nodeKey);
			if (!mutation) return;
			if (mutation === 'destroyed') {
				cleanup();
			}
		});

		return cleanup;
	});
</script>

<div class="rich-editor-details" data-variant={variant}>
	<button
		type="button"
		class="rich-editor-details-summary"
		aria-expanded={open}
		onclick={toggleOpen}
	>
		{summary}
	</button>
	<div class="rich-editor-details-body" hidden={!open}>
		<div
			bind:this={contentEl}
			class="rich-editor-details-editor"
			contenteditable="true"
			role="textbox"
			aria-multiline="true"
			onfocusin={() => rememberDecoratorFocus(nodeKey)}
			aria-label="容器内容"
		></div>
	</div>
</div>
