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
	import { GridNode } from './grid-node';

	type Props = {
		nodeKey: string;
		cols: number;
		gap: number;
		layout: 'grid' | 'masonry' | 'carousel';
		imageType: 'normal' | 'images';
		initialContent: string;
		parentEditor: LexicalEditor;
	};

	let { nodeKey, cols, gap, layout, imageType, initialContent, parentEditor }: Props = $props();

	const SYNC_DEBOUNCE_MS = 400;

	let nestedEditor: LexicalEditor | null = null;
	let contentEl: HTMLElement | undefined;
	let syncTimer: ReturnType<typeof setTimeout> | null = null;
	let isCleaned = false;

	let unregisterUpdate: (() => void) | undefined;
	let unregisterMutation: (() => void) | undefined;

	function cleanup() {
		if (isCleaned) return;
		isCleaned = true;
		if (syncTimer) clearTimeout(syncTimer);
		unregisterUpdate?.();
		unregisterMutation?.();
		nestedEditor?.setRootElement(null);
	}

	onMount(() => {
		nestedEditor = createEditor({
			namespace: 'grid-nested',
			nodes: NESTED_EDITOR_NODES,
			theme: EDITOR_THEME,
			onError: (error: Error) => console.error('Grid nested editor error:', error)
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
			console.error('Grid nested editor: failed to parse initial content', error);
		}

		unregisterUpdate = nestedEditor.registerUpdateListener(({ editorState }) => {
			if (syncTimer) clearTimeout(syncTimer);
			syncTimer = setTimeout(() => {
				const json = JSON.stringify(editorState.toJSON());
				parentEditor.update(() => {
					const node = getLexicalNodeByKey(nodeKey);
					if (node instanceof GridNode) node.setJsonContent(json);
				});
			}, SYNC_DEBOUNCE_MS);
		});

		unregisterMutation = parentEditor.registerMutationListener(GridNode, (mutations) => {
			const mutation = mutations.get(nodeKey);
			if (!mutation) return;
			if (mutation === 'destroyed') cleanup();
		});

		return cleanup;
	});
</script>

<div
	class="rich-editor-grid"
	data-layout={layout}
	data-type={imageType}
	style="--grid-cols: {cols}; --grid-gap: {gap}px"
>
	<div
		bind:this={contentEl}
		class="rich-editor-grid-editor"
		role="textbox"
		aria-multiline="true"
		onfocusin={() => rememberDecoratorFocus(nodeKey)}
		aria-label="网格内容"
	></div>
</div>
