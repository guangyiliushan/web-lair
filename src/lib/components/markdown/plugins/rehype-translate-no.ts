import type { Element, Root as HastRoot } from 'hast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

/**
 * `translate="no"` on rendered code (WHATWG HTML global attribute). This is
 * defence in depth for third-party translators; our own pipeline already
 * protects code spans before sending text to an AI provider. MDN documents
 * that the attribute is advisory ("not all browsers recognize it").
 */
export const rehypeTranslateNo: Plugin<[], HastRoot> = () => {
	return (tree) => {
		visit(tree, 'element', (node: Element) => {
			if (node.tagName !== 'pre' && node.tagName !== 'code') return;
			node.properties = { ...(node.properties ?? {}), translate: 'no' };
		});
	};
};
