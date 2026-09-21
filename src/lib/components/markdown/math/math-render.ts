import type { LexicalEditor } from 'lexical';

/** Event name dispatched on the editor root when a math node is clicked. */
export const MATH_EDIT_EVENT = 'rich-editor-math-edit';

export interface MathEditEventDetail {
	key: string;
}

/**
 * Renders `latex` into `host` with the render pipeline's KaTeX settings:
 * `trust: false`, `throwOnError: false` (spec 5: a parse failure shows the
 * source in a red error style instead of throwing).
 *
 * KaTeX is loaded lazily so the editor chunk does not pay for it until a
 * document with math is opened (same strategy as mermaid-client.ts).
 */
export function scheduleKatexRender(host: HTMLElement, latex: string, displayMode: boolean): void {
	void import('katex')
		.then(({ default: katex }) => {
			katex.render(latex, host, { throwOnError: false, displayMode, trust: false });
		})
		.catch(() => {
			host.textContent = latex;
			host.classList.add('rich-editor-math-error');
		});
}

/** Asks the surrounding editor UI to open the math edit dialog for a node. */
export function dispatchMathEdit(editor: LexicalEditor, key: string): void {
	editor.getRootElement()?.dispatchEvent(
		new CustomEvent<MathEditEventDetail>(MATH_EDIT_EVENT, {
			bubbles: true,
			detail: { key }
		})
	);
}
