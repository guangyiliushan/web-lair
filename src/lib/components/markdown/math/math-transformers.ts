/**
 * Math transformers for the editor (spec 2 #2): inline `$x$` / `\(x\)` and
 * the one-line block `$$x$$`.
 *
 * Opener/closer rules mirror remark-math-guard (render side): the opener may
 * not be preceded by a Unicode letter/digit/underscore or a backslash; the
 * closer may not be followed by a Unicode digit. Content padding is accepted
 * like micromark's math text and stored as written, so `$ x $` round-trips
 * byte-stable; a literal `$` inside the content refuses conversion.
 */
import { $createParagraphNode } from 'lexical';
import type { ElementTransformer, TextMatchTransformer } from '@lexical/markdown';
import { InlineMathNode, $createInlineMathNode, $isInlineMathNode } from './inline-math-node';
import { BlockMathNode, $createBlockMathNode, $isBlockMathNode } from './block-math-node';

const MATH_INLINE_DOLLAR = /(?<![\p{L}\p{N}_\\])\$(.+?)\$(?![\p{N}])/u;
/** Explicit paren notation (equivalent per spec; no guards needed). */
const MATH_INLINE_PAREN = /(?<!\\)\\\((.+?)\\\)/;
/** One-line `$$x$$` block (multiline `$$ ... $$` stays source text — registered). */
const MATH_BLOCK = /^\$\$(.+?)\$\$\s*$/;

export const mathInlineTransformer: TextMatchTransformer = {
	dependencies: [InlineMathNode],
	importRegExp: MATH_INLINE_DOLLAR,
	regExp: /(?<![\p{L}\p{N}_\\])\$(.+?)\$(?![\p{N}])$/u,
	trigger: '$',
	replace: (textNode, match) => {
		if (textNode.hasFormat('code')) return;
		const inner = match[1];
		if (!inner.trim() || inner.includes('$')) return;
		textNode.replace($createInlineMathNode(inner, 'dollar'));
	},
	export: (node) => ($isInlineMathNode(node) ? node.getTextContent() : null),
	type: 'text-match'
};

export const mathParenTransformer: TextMatchTransformer = {
	dependencies: [InlineMathNode],
	importRegExp: MATH_INLINE_PAREN,
	regExp: /(?<!\\)\\\((.+?)\\\)$/,
	trigger: ')',
	replace: (textNode, match) => {
		if (textNode.hasFormat('code')) return;
		const inner = match[1];
		if (!inner.trim()) return;
		textNode.replace($createInlineMathNode(inner, 'paren'));
	},
	// Serialization is form-agnostic: the first matching exporter (the dollar
	// one) writes both forms through getTextContent().
	export: (node) => ($isInlineMathNode(node) ? node.getTextContent() : null),
	type: 'text-match'
};

export const mathBlockTransformer: ElementTransformer = {
	dependencies: [BlockMathNode],
	export: (node) => ($isBlockMathNode(node) ? node.getTextContent() : null),
	regExp: MATH_BLOCK,
	replace: (parentNode, _children, match, isImport) => {
		void _children;
		if (!match[1].trim()) return;
		const node = $createBlockMathNode(match[1]);
		parentNode.replace(node);
		// typing path at the end of the document: leave a paragraph for the caret
		if (!isImport && !node.getNextSibling()) {
			const paragraph = $createParagraphNode();
			node.insertAfter(paragraph);
			paragraph.select();
		}
	},
	type: 'element'
};
