/**
 * Footnote transformers for the editor (L1 GFM footnotes; pandoc-style inline
 * footnotes). Refs and inline notes become atomic chips; definition lines
 * (`[^label]: ...`) stay literal source text (registered follow-up: a
 * definitions panel).
 *
 * Guards: a backslash before the opener keeps the text literal (spec 4.4);
 * the ref form blocks a trailing colon so the definition line never converts.
 */
import type { TextMatchTransformer } from '@lexical/markdown';
import { FootnoteRefNode, $createFootnoteRefNode, $isFootnoteRefNode } from './footnote-ref-node';
import {
	FootnoteInlineNode,
	$createFootnoteInlineNode,
	$isFootnoteInlineNode
} from './footnote-inline-node';

const FOOTNOTE_REF = /(?<!\\)\[\^([^\]\s]+)\](?!:)/;
const FOOTNOTE_INLINE = /(?<!\\)\^\[([^\]]+)\]/;

export const footnoteRefTransformer: TextMatchTransformer = {
	dependencies: [FootnoteRefNode],
	importRegExp: FOOTNOTE_REF,
	regExp: /(?<!\\)\[\^([^\]\s]+)\](?!:)$/,
	trigger: ']',
	replace: (textNode, match) => {
		if (textNode.hasFormat('code')) return;
		textNode.replace($createFootnoteRefNode(match[0]));
	},
	export: (node) => ($isFootnoteRefNode(node) ? node.getTextContent() : null),
	type: 'text-match'
};

export const footnoteInlineTransformer: TextMatchTransformer = {
	dependencies: [FootnoteInlineNode],
	importRegExp: FOOTNOTE_INLINE,
	regExp: /(?<!\\)\^\[([^\]]+)\]$/,
	trigger: ']',
	replace: (textNode, match) => {
		if (textNode.hasFormat('code')) return;
		textNode.replace($createFootnoteInlineNode(match[0]));
	},
	export: (node) => ($isFootnoteInlineNode(node) ? node.getTextContent() : null),
	type: 'text-match'
};
