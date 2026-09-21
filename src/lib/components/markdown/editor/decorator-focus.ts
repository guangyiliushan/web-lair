/**
 * Decorator focus memory (batch D fix): writing the nested-editor JSON back
 * dirties the node, Lexical re-runs decorate() and the decorator remounts.
 * Remembering which decorator owned the focus lets the remounted instance
 * take it back instead of dropping every following keystroke.
 */
const focusMemory = new Set<string>();

export function rememberDecoratorFocus(nodeKey: string): void {
	focusMemory.add(nodeKey);
}

export function shouldRestoreDecoratorFocus(nodeKey: string): boolean {
	return focusMemory.has(nodeKey);
}
