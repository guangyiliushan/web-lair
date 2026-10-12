<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { createEditor, $getNodeByKey as getLexicalNodeByKey, type LexicalEditor } from 'lexical';
	import { registerRichText } from '@lexical/rich-text';
	import { registerHistory, createEmptyHistoryState } from '@lexical/history';
	import { EDITOR_THEME, NESTED_EDITOR_NODES } from '$lib/components/markdown/editor/editor-shared';
	import { isAlertNode } from '$lib/components/markdown/editor/lexical-helpers';
	import { AlertNode } from './alert-node';
	import type { AlertType } from './alert-types';
	import { ALERT_LABELS, ALERT_TYPES } from './alert-types';
	import { m } from '$lib/paraglide/messages';
	import { registerExitBlock } from './exit-block';

	// ── Icons ──
	import IconInfoCircle from '@tabler/icons-svelte-runes/icons/info-circle';
	import IconBulb from '@tabler/icons-svelte-runes/icons/bulb';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import IconAlertOctagon from '@tabler/icons-svelte-runes/icons/alert-octagon';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';

	// ── Props ──
	type Props = {
		nodeKey: string;
		alertType: AlertType;
		title: string;
		initialContent: string;
		parentEditor: LexicalEditor;
	};

	let { nodeKey, alertType, title, initialContent, parentEditor }: Props = $props();

	// ── State ──
	let nestedEditor: LexicalEditor | null = $state(null);
	let contentEl: HTMLElement | undefined;
	let currentAlertType = $derived(alertType);
	let runtimeError: Error | null = $state(null);
	let lastAppliedJson = $state('');
	let dropdownOpen = $state(false);
	let dropdownHover = $state(false);
	let headerEl: HTMLElement | undefined = $state();
	let dropdownTimeout: ReturnType<typeof setTimeout> | null = null;

	// Sync prop changes into internal state
	$effect(() => {
		currentAlertType = alertType;
	});

	// ── Dropdown: open on hover / close on mouseleave ──
	function onHeaderEnter() {
		if (dropdownTimeout) {
			clearTimeout(dropdownTimeout);
			dropdownTimeout = null;
		}
		dropdownHover = true;
		dropdownOpen = true;
	}
	function onHeaderLeave() {
		dropdownHover = false;
		// Close after a short delay to let the pointer move onto the dropdown
		dropdownTimeout = setTimeout(() => {
			if (!dropdownHover) dropdownOpen = false;
		}, 150);
	}
	function onDropdownEnter() {
		if (dropdownTimeout) {
			clearTimeout(dropdownTimeout);
			dropdownTimeout = null;
		}
		dropdownHover = true;
	}
	function onDropdownLeave() {
		dropdownHover = false;
		dropdownTimeout = setTimeout(() => {
			if (!dropdownHover) dropdownOpen = false;
		}, 100);
	}

	// ── Sync control ──
	const SYNC_DEBOUNCE_MS = 400;
	let syncTimer: ReturnType<typeof setTimeout> | null = null;
	let isApplyingParentSnapshot = false;
	let unregisterUpdate: (() => void) | undefined;
	let unregisterMutation: (() => void) | undefined;
	let unregisterExit: (() => void) | undefined;
	let isCleaned = false;

	// ── Type options ──
	const ALERT_ICONS: Record<AlertType, typeof IconInfoCircle> = {
		note: IconInfoCircle,
		tip: IconBulb,
		important: IconAlertCircle,
		warning: IconAlertTriangle,
		caution: IconAlertOctagon
	};
	const TYPE_OPTIONS: { type: AlertType; label: string; icon: typeof IconInfoCircle }[] =
		ALERT_TYPES.map((type) => ({ type, label: ALERT_LABELS[type]?.(), icon: ALERT_ICONS[type] }));

	const currentOption = $derived(
		TYPE_OPTIONS.find((o) => o.type === currentAlertType) ?? TYPE_OPTIONS[0]
	);
	let CurrentOptionIcon = $derived(currentOption.icon);

	function bindContentRoot(node: HTMLElement) {
		contentEl = node;
		return {
			destroy() {
				if (contentEl === node) {
					contentEl = undefined;
				}
			}
		};
	}

	// ── Cleanup ──
	function cleanup() {
		if (isCleaned) return;
		isCleaned = true;

		if (syncTimer) clearTimeout(syncTimer);
		unregisterUpdate?.();
		unregisterExit?.();
		unregisterMutation?.();
		nestedEditor?.setRootElement(null);
	}

	// ── Type switching ──
	function changeAlertType(type: AlertType) {
		parentEditor.update(() => {
			const node = getLexicalNodeByKey(nodeKey);
			if (isAlertNode(node)) {
				node.setAlertType(type);
			}
		});
	}

	// ── Initialization ──
	onMount(() => {
		nestedEditor = createEditor({
			namespace: 'alert-nested',
			nodes: NESTED_EDITOR_NODES,
			theme: EDITOR_THEME,
			onError: (error: Error) => console.error('Nested editor error:', error)
		});

		if (!contentEl) return;
		nestedEditor.setRootElement(contentEl);
		nestedEditor.setEditable(true);
		registerRichText(nestedEditor);
		registerHistory(nestedEditor, createEmptyHistoryState(), 300);

		// Inject the initial content
		try {
			const state = nestedEditor.parseEditorState(initialContent);
			nestedEditor.setEditorState(state);
			lastAppliedJson = initialContent;
		} catch (e) {
			runtimeError = e instanceof Error ? e : new Error(String(e));
			console.error('Alert nested editor: failed to parse initial content', e);
		}

		// ── Child → parent sync ──
		unregisterUpdate = nestedEditor.registerUpdateListener(({ editorState }) => {
			if (isApplyingParentSnapshot) return;
			if (syncTimer) clearTimeout(syncTimer);
			syncTimer = setTimeout(() => {
				const json = JSON.stringify(editorState.toJSON());
				parentEditor.update(() => {
					const node = getLexicalNodeByKey(nodeKey);
					if (isAlertNode(node) && node.__jsonContent !== json) {
						node.setJsonContent(json);
					}
				});
			}, SYNC_DEBOUNCE_MS);
		});

		// ── Parent → child sync / hard cleanup ──
		unregisterMutation = parentEditor.registerMutationListener(
			AlertNode,
			(mutations) => {
				const mutation = mutations.get(nodeKey);
				if (!mutation) return;

				if (mutation === 'destroyed') {
					cleanup();
					return;
				}

				// 'created' or 'updated'
				parentEditor.getEditorState().read(() => {
					const node = getLexicalNodeByKey(nodeKey) as AlertNode | null;
					if (!node || !nestedEditor) return;

					const latestJson = node.__jsonContent;
					if (latestJson !== lastAppliedJson) {
						try {
							isApplyingParentSnapshot = true;
							const state = nestedEditor.parseEditorState(latestJson);
							nestedEditor.setEditorState(state);
							lastAppliedJson = latestJson;
						} catch (e) {
							runtimeError = e instanceof Error ? e : new Error(String(e));
						} finally {
							isApplyingParentSnapshot = false;
						}
					}
				});
			},
			{ skipInitialization: true }
		);

		// ── Keyboard escape ──
		unregisterExit = registerExitBlock(nestedEditor, parentEditor, nodeKey);
	});

	onDestroy(cleanup);
</script>

{#if runtimeError}
	<div class="rich-editor-alert rich-editor-alert-error" contenteditable="false">
		<p class="text-sm">{m.editor_corrupt_block()}</p>
	</div>
{:else}
	<div class="rich-editor-alert rich-editor-alert-{currentAlertType}" contenteditable="false">
		<!-- Header: compact title bar matching the reference design -->
		<div
			class="rich-editor-alert-header rich-editor-alert-header-{currentAlertType}"
			bind:this={headerEl}
			role="toolbar"
			tabindex="-1"
			aria-label={m.editor_alert_type()}
			onmouseenter={onHeaderEnter}
			onmouseleave={onHeaderLeave}
		>
			<button
				type="button"
				class="rich-editor-alert-type-btn"
				aria-haspopup="menu"
				aria-expanded={dropdownOpen}
				onclick={() => (dropdownOpen = true)}
			>
				<CurrentOptionIcon class="rich-editor-alert-icon" aria-hidden="true" />
				<span class="rich-editor-alert-label">{currentOption.label}</span>
				<IconChevronDown class="rich-editor-alert-chevron" aria-hidden="true" />
				{#if title}<span class="rich-editor-alert-title">{title}</span>{/if}
			</button>
			<!-- Alert-type switcher dropdown -->
			{#if dropdownOpen}
				<div
					class="rich-editor-alert-dropdown"
					role="menu"
					tabindex="-1"
					onmouseenter={onDropdownEnter}
					onmouseleave={onDropdownLeave}
				>
					{#each TYPE_OPTIONS as option (option.type)}
						{@const OptionIcon = option.icon}
						<button
							type="button"
							role="menuitem"
							class="rich-editor-alert-dropdown-item"
							class:active={option.type === currentAlertType}
							onclick={() => {
								changeAlertType(option.type);
								dropdownOpen = false;
							}}
						>
							<OptionIcon
								class="rich-editor-alert-option-icon rich-editor-alert-option-icon-{option.type}"
								aria-hidden="true"
							/>
							<span>{option.label}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Content -->
		<div class="rich-editor-alert-content">
			<div use:bindContentRoot class="rich-editor-alert-editor" contenteditable="true"></div>
		</div>
	</div>
{/if}
