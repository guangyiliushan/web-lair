import type { Plugin } from 'unified';
import type { Root, Element } from 'hast';
import { visit } from 'unist-util-visit';
import { classList } from './hast-class';

/**
 * rehypeMermaid turns `language-mermaid` code blocks into `<pre class="mermaid">` mount
 * points.
 * It MUST run before rehype-pretty-code: pretty-code rebuilds the block and drops the
 * language class, so the pristine `pre > code.language-mermaid` shape this pass matches
 * only exists before it (order rationale lives in rehype-code-meta.ts). Both pipelines
 * register the pass at the same position (server/markdown.ts, markdown-config.ts).
 * The client execution side lives in editor/mermaid-client.ts and mermaid-exec.svelte.spec.ts
 * pins the behaviour; without javascript the mount point renders the raw diagram source.
 */
export const rehypeMermaid: Plugin<[], Root> = () => {
	return (tree) => {
		visit(tree, 'element', (node: Element) => {
			if (node.tagName !== 'pre') return;

			// The pass runs before pretty-code, so the direct `pre > code` child
			// is the original shape; check it as-is.
			const child = node.children?.find(
				(c): c is Element => c.type === 'element' && c.tagName === 'code'
			);
			if (!child) return;

			if (!classList(child).includes('language-mermaid')) return;

			// Extract the code content
			const codeContent = (child.children ?? [])
				.filter((c) => c.type === 'text')
				.map((c) => (c as { value: string }).value)
				.join('');

			// Replace it with the mermaid mount point
			node.tagName = 'pre';
			node.properties = { className: ['mermaid'] };
			node.children = [{ type: 'text', value: codeContent }];
		});
	};
};
