<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { LexicalEditor } from 'lexical';
	import { Button } from '$lib/components/ui/button';
	import {
		getCellRect,
		readTableCellContext,
		tableDeleteColumn,
		tableDeleteRow,
		tableInsertColumn,
		tableInsertRow,
		tableToggleHeader
	} from '$lib/components/markdown/editor/table-helpers';

	// ── 图标 ──
	import IconRowInsertTop from '@tabler/icons-svelte-runes/icons/row-insert-top';
	import IconRowInsertBottom from '@tabler/icons-svelte-runes/icons/row-insert-bottom';
	import IconColumnInsertLeft from '@tabler/icons-svelte-runes/icons/column-insert-left';
	import IconColumnInsertRight from '@tabler/icons-svelte-runes/icons/column-insert-right';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconTableOptions from '@tabler/icons-svelte-runes/icons/table-options';

	type Props = {
		editor: LexicalEditor | null;
	};

	let { editor }: Props = $props();

	// ── 可见性与位置 ──
	let visible = $state(false);
	let top = $state(0);
	let left = $state(0);

	const MENU_HEIGHT = 36;

	// ── 监听选区：光标进入表格单元格时显示菜单 ──
	$effect(() => {
		if (!editor) return;

		const unregister = editor.registerUpdateListener(({ editorState }) => {
			if (!editor.isEditable()) {
				visible = false;
				return;
			}
			const ctx = editorState.read(readTableCellContext);
			if (!ctx) {
				visible = false;
				return;
			}
			const rect = getCellRect(editor, ctx.cellKey);
			if (!rect || rect.width === 0) {
				visible = false;
				return;
			}
			// 定位在当前单元格上方居中；顶部空间不足时放到下方
			top = rect.top - MENU_HEIGHT - 6;
			if (top < 8) {
				top = rect.bottom + 6;
			}
			left = rect.left + rect.width / 2;
			visible = true;
		});

		return unregister;
	});

	function preventSelectionLoss(e: MouseEvent) {
		e.preventDefault();
	}
</script>

{#if visible}
	<div
		class="fixed z-50 flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-md"
		style="top: {top}px; left: {left}px; transform: translateX(-50%);"
		role="toolbar"
		aria-label={m.toolbar_table_menu()}
	>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => tableInsertRow(editor!, false)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_insert_row_above()}
			title={m.toolbar_insert_row_above()}
		>
			<IconRowInsertTop data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => tableInsertRow(editor!, true)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_insert_row_below()}
			title={m.toolbar_insert_row_below()}
		>
			<IconRowInsertBottom data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => tableInsertColumn(editor!, false)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_insert_col_left()}
			title={m.toolbar_insert_col_left()}
		>
			<IconColumnInsertLeft data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => tableInsertColumn(editor!, true)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_insert_col_right()}
			title={m.toolbar_insert_col_right()}
		>
			<IconColumnInsertRight data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => tableToggleHeader(editor!)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_toggle_header()}
			title={m.toolbar_toggle_header()}
		>
			<IconTableOptions data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => tableDeleteRow(editor!)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_delete_row()}
			title={m.toolbar_delete_row()}
		>
			<IconTrash data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => tableDeleteColumn(editor!)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_delete_col()}
			title={m.toolbar_delete_col()}
		>
			<IconTrash data-icon="inline-start" />
		</Button>
	</div>
{/if}
