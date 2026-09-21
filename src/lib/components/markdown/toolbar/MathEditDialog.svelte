<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import IconMath from '@tabler/icons-svelte-runes/icons/math';
	import { m } from '$lib/paraglide/messages';
	import { scheduleKatexRender } from '$lib/components/markdown/math/math-render';

	type Props = {
		open: boolean;
		initialLatex: string;
		displayMode?: boolean;
		onSave: (latex: string) => void;
	};

	let { open = $bindable(), initialLatex = '', displayMode = false, onSave }: Props = $props();

	let latex = $state('');
	let previewEl = $state<HTMLDivElement | null>(null);

	// Load the node's current source whenever the dialog opens.
	$effect(() => {
		if (open) {
			latex = initialLatex;
		}
	});

	// Live KaTeX preview (same settings as the editor/preview pipelines).
	$effect(() => {
		const value = latex;
		const el = previewEl;
		if (!el) return;
		el.textContent = '';
		if (value.trim().length > 0) {
			scheduleKatexRender(el, value, displayMode);
		}
	});

	const hasInvalidChar = $derived(latex.includes('$'));
	const canSave = $derived(latex.trim().length > 0 && !latex.includes('$'));

	function handleSave() {
		if (!canSave) return;
		onSave(latex);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<IconMath class="size-4" />
					{m.math_dialog_title()}
				</Dialog.Title>
				<Dialog.Description>{m.math_dialog_description()}</Dialog.Description>
			</Dialog.Header>

			<div class="flex flex-col gap-4">
				<div class="flex flex-col gap-2">
					<Label for="math-latex">{m.math_latex_label()}</Label>
					<textarea
						id="math-latex"
						class="min-h-24 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
						placeholder={'e^{i\\pi} + 1 = 0'}
						bind:value={latex}
					></textarea>
				</div>
				{#if hasInvalidChar}
					<p class="text-xs text-destructive">{m.math_latex_invalid()}</p>
				{/if}
				<div
					class="flex min-h-14 items-center justify-center rounded-md border border-border bg-muted/30 p-2"
				>
					<div bind:this={previewEl} class="max-w-full overflow-x-auto text-center"></div>
				</div>
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>{m.math_cancel()}</Button>
				<Button disabled={!canSave} onclick={handleSave}>
					<IconMath data-icon="inline-start" />
					{m.math_save()}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
