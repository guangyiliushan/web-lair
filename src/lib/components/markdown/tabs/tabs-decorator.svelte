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
	import { TabsNode } from './tabs-node';

	type Entry = { label: string; jsonContent: string };
	type Props = {
		nodeKey: string;
		tabs: Entry[];
		parentEditor: LexicalEditor;
	};

	let { nodeKey, tabs, parentEditor }: Props = $props();

	const SYNC_DEBOUNCE_MS = 400;

	let activeIndex = $state(0);
	let nestedEditor: LexicalEditor | null = null;
	let contentEl: HTMLElement | undefined;
	let syncTimer: ReturnType<typeof setTimeout> | null = null;
	let isCleaned = false;

	let unregisterUpdate: (() => void) | undefined;
	let unregisterMutation: (() => void) | undefined;
	let lastAppliedIndex = -1;

	function cleanup() {
		if (isCleaned) return;
		isCleaned = true;
		if (syncTimer) clearTimeout(syncTimer);
		unregisterUpdate?.();
		unregisterMutation?.();
		nestedEditor?.setRootElement(null);
	}

	function switchTab(index: number) {
		if (index === activeIndex) return;
		// flush the pending body write before swapping the panel
		if (syncTimer) {
			clearTimeout(syncTimer);
			syncTimer = null;
			if (nestedEditor) {
				const json = JSON.stringify(nestedEditor.getEditorState().toJSON());
				const current = activeIndex;
				parentEditor.update(() => {
					const node = getLexicalNodeByKey(nodeKey);
					if (node instanceof TabsNode) node.setTabJson(current, json);
				});
			}
		}
		activeIndex = index;
	}

	onMount(() => {
		nestedEditor = createEditor({
			namespace: 'tabs-nested',
			nodes: NESTED_EDITOR_NODES,
			theme: EDITOR_THEME,
			onError: (error: Error) => console.error('Tabs nested editor error:', error)
		});

		if (!contentEl) return;
		nestedEditor.setRootElement(contentEl);
		nestedEditor.setEditable(true);
		if (shouldRestoreDecoratorFocus(nodeKey)) contentEl.focus();
		registerRichText(nestedEditor);
		registerHistory(nestedEditor, createEmptyHistoryState(), 300);
		applyTab(activeIndex);

		unregisterUpdate = nestedEditor.registerUpdateListener(({ editorState }) => {
			if (syncTimer) clearTimeout(syncTimer);
			syncTimer = setTimeout(() => {
				const json = JSON.stringify(editorState.toJSON());
				const current = activeIndex;
				parentEditor.update(() => {
					const node = getLexicalNodeByKey(nodeKey);
					if (node instanceof TabsNode) node.setTabJson(current, json);
				});
			}, SYNC_DEBOUNCE_MS);
		});

		unregisterMutation = parentEditor.registerMutationListener(TabsNode, (mutations) => {
			const mutation = mutations.get(nodeKey);
			if (!mutation) return;
			if (mutation === 'destroyed') cleanup();
		});

		return cleanup;
	});

	function applyTab(index: number) {
		const ed = nestedEditor;
		if (!ed || index === lastAppliedIndex) return;
		lastAppliedIndex = index;
		const entry = tabs[index];
		try {
			ed.setEditorState(
				ed.parseEditorState(entry?.jsonContent ?? JSON.stringify({ root: { children: [] } }))
			);
		} catch (error) {
			console.error('Tabs nested editor: failed to parse tab content', error);
		}
	}

	// re-load only when the tab actually changes: unconditional reapplies
	// plus the debounced writer would form a decorate/update loop
	$effect(() => {
		const index = activeIndex;
		void contentEl;
		applyTab(index);
	});
</script>

<div class="rich-editor-tabs">
	<div class="rich-editor-tabs-strip" role="tablist" aria-label="标签页">
		{#each tabs as tab, index (index)}
			<button
				type="button"
				role="tab"
				aria-selected={index === activeIndex}
				tabindex={index === activeIndex ? 0 : -1}
				class="rich-editor-tabs-tab"
				onclick={() => switchTab(index)}
				onkeydown={(e) => {
					if (e.key === 'ArrowRight') switchTab((index + 1) % tabs.length);
					if (e.key === 'ArrowLeft') switchTab((index - 1 + tabs.length) % tabs.length);
				}}
			>
				{tab.label}
			</button>
		{/each}
	</div>
	<div role="tabpanel" class="rich-editor-tabs-panel">
		<div
			bind:this={contentEl}
			class="rich-editor-tabs-editor"
			contenteditable="true"
			role="textbox"
			aria-multiline="true"
			onfocusin={() => rememberDecoratorFocus(nodeKey)}
			aria-label="标签页内容"
		></div>
	</div>
</div>
