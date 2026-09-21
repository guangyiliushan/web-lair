/**
 * Batch C transformers: the export side of embed cards and mermaid blocks
 * plus the mermaid fence import.
 *
 * - `embedTransformer` is export-only (its regExp never matches): the import
 *   side lives in the image transformer, which branches through `decideImage`.
 * - `mermaidTransformer` mirrors the core code-fence transformer for the
 *   `mermaid` language only; other languages fall through to the core. An
 *   unterminated fence returns null and also falls through.
 */
import type { ElementTransformer, MultilineElementTransformer } from '@lexical/markdown';
import { EmbedNode, $isEmbedNode } from '$lib/components/markdown/embed/embed-node';
import { MermaidNode, $createMermaidNode, $isMermaidNode } from './mermaid-block-node';

const FENCE = String.fromCharCode(96).repeat(3);
const MERMAID_START = new RegExp('^' + FENCE + 'mermaid\\s*$');
const MERMAID_END = new RegExp('^' + FENCE + '\\s*$');

export const embedTransformer: ElementTransformer = {
	dependencies: [EmbedNode],
	export: (node) =>
		$isEmbedNode(node)
			? '![' +
				node.getTitle() +
				'](' +
				node.getUrl() +
				')' +
				(node.getTail() ? ' {' + node.getTail() + '}' : '')
			: null,
	regExp: /$^/,
	replace: () => false,
	type: 'element'
};

export const mermaidTransformer: MultilineElementTransformer = {
	dependencies: [MermaidNode],
	regExpStart: MERMAID_START,
	regExpEnd: { regExp: MERMAID_END, optional: true },
	handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
		const body: string[] = [];
		let i = startLineIndex + 1;
		while (i < lines.length && !MERMAID_END.test(lines[i] ?? '')) {
			body.push(lines[i] ?? '');
			i++;
		}
		// Unterminated fences still render as diagrams in the published pipeline
		// (language-mermaid pre), so the editor consumes to EOF the same way.
		rootNode.append($createMermaidNode(body.join(String.fromCharCode(10))));
		return [true, Math.min(i, lines.length - 1)];
	},
	replace: () => false,
	export: (node) =>
		$isMermaidNode(node)
			? FENCE +
				'mermaid' +
				String.fromCharCode(10) +
				node.getSource() +
				String.fromCharCode(10) +
				FENCE
			: null,
	type: 'multiline-element'
};
