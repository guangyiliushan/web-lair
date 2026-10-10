<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorState } from '@codemirror/state';
	import {
		EditorView,
		highlightActiveLine,
		highlightActiveLineGutter,
		keymap,
		lineNumbers
	} from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import {
		bracketMatching,
		defaultHighlightStyle,
		indentOnInput,
		syntaxHighlighting
	} from '@codemirror/language';
	import { javascript } from '@codemirror/lang-javascript';

	/**
	 * Thin CodeMirror 6 wrapper for the jobs script editor (J-2, plan §5.6):
	 * official fine-grained packages only (no community wrapper), themed
	 * through the app's CSS variables. Consumers must import this component
	 * lazily at the route level (`await import(...)`) so the editor weight is
	 * paid only on pages that actually mount it.
	 */
	interface Props {
		value: string;
		/** Fired on every user edit with the full document. */
		onChange?: (value: string) => void;
		/** Mod-s inside the editor; the component never renders its own button. */
		onSave?: () => void;
		/**
		 * Mount-time flag: the CodeMirror read-only/editable facets are set
		 * once at editor creation, so toggling at runtime needs a remount
		 * (e.g. wrap the host in `{#key readonly}`). Documented J-2 review
		 * note; the saved editor contract is decided by the save gate anyway.
		 */
		readonly?: boolean;
		ariaLabel?: string;
		class?: string;
	}
	let {
		value,
		onChange,
		onSave,
		readonly = false,
		ariaLabel = 'Job script editor',
		class: className
	}: Props = $props();

	let container: HTMLDivElement | undefined;
	let view: EditorView | null = null;
	/** Suppress the update listener while the doc is replaced from outside. */
	let suppressChange = false;

	onMount(() => {
		if (!container) return;
		view = new EditorView({
			state: EditorState.create({
				doc: value,
				extensions: [
					lineNumbers(),
					highlightActiveLine(),
					highlightActiveLineGutter(),
					history(),
					bracketMatching(),
					indentOnInput(),
					javascript(),
					syntaxHighlighting(defaultHighlightStyle),
					EditorState.readOnly.of(readonly),
					EditorView.editable.of(!readonly),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({
						'aria-label': ariaLabel,
						...(readonly ? { 'aria-readonly': 'true' } : {})
					}),
					keymap.of([
						{
							key: 'Mod-s',
							preventDefault: true,
							run: () => {
								onSave?.();
								return true;
							}
						},
						indentWithTab,
						...defaultKeymap,
						...historyKeymap
					]),
					EditorView.updateListener.of((update) => {
						if (!update.docChanged || suppressChange) return;
						onChange?.(update.state.doc.toString());
					}),
					EditorView.theme({
						'&': {
							color: 'var(--foreground)',
							backgroundColor: 'transparent',
							fontSize: '13px',
							height: '100%'
						},
						'.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
						'.cm-content': { caretColor: 'var(--foreground)' },
						'.cm-gutters': {
							backgroundColor: 'transparent',
							color: 'var(--muted-foreground)',
							border: 'none'
						},
						'.cm-activeLine': {
							backgroundColor: 'color-mix(in oklab, var(--accent) 35%, transparent)'
						},
						'.cm-activeLineGutter': { backgroundColor: 'transparent' },
						'&.cm-focused': { outline: 'none' },
						'.cm-cursor': { borderLeftColor: 'var(--foreground)' }
					})
				]
			}),
			parent: container
		});
		return () => {
			view?.destroy();
			view = null;
		};
	});

	// Reconcile external value changes (e.g. "reload from server" after a save
	// conflict) into the doc without echoing them back through onChange.
	$effect(() => {
		const next = value;
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === next) return;
		suppressChange = true;
		try {
			view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
		} finally {
			suppressChange = false;
		}
	});
</script>

<div bind:this={container} class={className} data-slot="job-editor"></div>
