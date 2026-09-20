import type { Plugin } from 'unified';
import type { Root, Element } from 'hast';
import { visit } from 'unist-util-visit';
import { classList } from './hast-class';

/**
 * rehype-mermaid: turns `language-mermaid` code blocks into `<pre class="mermaid">`
 * mount points.
 *
 * It MUST run BEFORE rehype-pretty-code: pretty-code rebuilds the block (it
 * renames the pre to a figure and creates a fresh pre inside, dropping the
 * language class), so the pristine `pre > code.language-mermaid` shape this
 * pass matches only exists before it. Both pipelines register the pass at the
 * same position (server/markdown.ts, markdown-config.ts).
 *
 * The client execution side lives in editor/mermaid-client.ts (lazy import,
 * `htmlLabels: false` + directive stripping for spec 6, palette from the
 * theme tokens); mermaid-exec.svelte.spec.ts pins the behaviour. Without
 * javascript the mount point renders the raw diagram source as plain text.
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

			// 提取代码内容
			const codeContent = (child.children ?? [])
				.filter((c) => c.type === 'text')
				.map((c) => (c as { value: string }).value)
				.join('');

			// 替换为 mermaid 挂载点
			node.tagName = 'pre';
			node.properties = { className: ['mermaid'] };
			node.children = [{ type: 'text', value: codeContent }];
		});
	};
};
