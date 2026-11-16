import {
	$getSelection,
	$getNodeByKey,
	$isRangeSelection,
	type LexicalNode,
	type LexicalEditor
} from 'lexical';
import {
	$isTableSelection,
	$isTableCellNode,
	TableCellHeaderStates,
	$insertTableRowAtSelection,
	$insertTableColumnAtSelection,
	$deleteTableRowAtSelection,
	$deleteTableColumnAtSelection,
	type TableCellNode
} from '@lexical/table';

// ── Table row/column helpers (used by TableCellMenu.svelte) ──
// Same pattern as lexical-helpers.ts: wrap the $-prefixed helpers so .svelte never imports them.

/** Table selection context (basis for positioning the floating menu) */
export interface TableCellMenuContext {
	cellKey: string;
}

/** Get the table cell containing the selection (the anchor cell for a TableSelection) */
function $getSelectedCell(): TableCellNode | null {
	const selection = $getSelection();
	if ($isTableSelection(selection)) {
		// A TableSelection's anchor.key is the key of the TableCellNode
		const cell = $getNodeByKey(selection.anchor.key);
		return $isTableCellNode(cell) ? cell : null;
	}
	if ($isRangeSelection(selection)) {
		let node: LexicalNode | null = selection.anchor.getNode();
		while (node !== null) {
			if ($isTableCellNode(node)) return node;
			node = node.getParent();
		}
	}
	return null;
}

/**
 * Read the floating-menu context inside editorState.read().
 * Returns null when the cursor/selection is not inside a table.
 */
export function readTableCellContext(): TableCellMenuContext | null {
	const cell = $getSelectedCell();
	return cell ? { cellKey: cell.getKey() } : null;
}

/** Get the cell's DOM rect (for positioning the floating menu) */
export function getCellRect(editor: LexicalEditor, cellKey: string): DOMRect | null {
	return editor.getElementByKey(cellKey)?.getBoundingClientRect() ?? null;
}

/** Insert a row above/below the current cell */
export function tableInsertRow(editor: LexicalEditor, after: boolean) {
	editor.update(() => {
		$insertTableRowAtSelection(after);
	});
}

/** Insert a column left/right of the current cell */
export function tableInsertColumn(editor: LexicalEditor, after: boolean) {
	editor.update(() => {
		$insertTableColumnAtSelection(after);
	});
}

/** Delete the current row */
export function tableDeleteRow(editor: LexicalEditor) {
	editor.update(() => {
		$deleteTableRowAtSelection();
	});
}

/** Delete the current column */
export function tableDeleteColumn(editor: LexicalEditor) {
	editor.update(() => {
		$deleteTableColumnAtSelection();
	});
}

/**
 * Toggle the header state of the current row (decided by whether the anchor cell is a
 * header cell; the whole row flips together).
 */
export function tableToggleHeader(editor: LexicalEditor) {
	editor.update(() => {
		const cell = $getSelectedCell();
		if (!cell) return;
		const row = cell.getParent();
		if (!row) return;
		const makeHeader = !cell.hasHeader();
		for (const child of row.getChildren()) {
			if ($isTableCellNode(child) && child.hasHeader() !== makeHeader) {
				child.toggleHeaderStyle(TableCellHeaderStates.ROW);
			}
		}
	});
}
