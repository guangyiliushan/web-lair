import type { Plugin } from 'unified';
import type { Root as HastRoot, Element } from 'hast';
import { visit, SKIP } from 'unist-util-visit';
import { META_ATTR, type CodeMeta } from './remark-code-meta';

/**
 * Code-fence info-string rendering (spec 3.3) — runs BEFORE rehype-pretty-code
 * and rehype-mermaid, and before the provenance stamping, on purpose: at this
 * point the block is the plain pre/code pair, the only shape that is stable
 * across both pipelines. Shiki afterwards rebuilds the block (it renames the
 * pre to the figure and builds a fresh pre inside), so anything placed after
 * that pass would land on a different element per pipeline.
 *
 * - `title` without `collapsed`: a small caption line above the block
 * - `collapsed` / `collapsed=N`: the block is wrapped in a native
 *   `<details class="md-code-collapsed">` whose summary carries the title
 *   (`代码` when absent); `=N` rides as `data-md-collapse` for the client
 *   enhancement that renders the partial preview
 * - the transport attribute is consumed here and deleted; it is read before
 *   rehype-raw runs (raw content can never smuggle it) and it is not in the
 *   sanitize schema either
 */

function readMeta(pre: Element): CodeMeta | null {
	const code = pre.children.find(
		(child): child is Element => child.type === 'element' && child.tagName === 'code'
	);
	const raw = code?.properties?.[META_ATTR];
	if (code) delete code.properties?.[META_ATTR];
	if (typeof raw !== 'string') return null;
	try {
		return JSON.parse(raw) as CodeMeta;
	} catch {
		return null;
	}
}

function titleLine(text: string): Element {
	return {
		type: 'element',
		tagName: 'p',
		properties: { className: ['md-code-title'] },
		children: [{ type: 'text', value: text }]
	};
}

export const rehypeCodeMeta: Plugin<[], HastRoot> = () => {
	return (tree) => {
		visit(tree, 'element', (node: Element, index, parent) => {
			if (node.tagName !== 'pre' || index == null || !parent) return;
			const meta = readMeta(node);
			if (!meta) return;

			// line numbering is on by default; this marker is consumed by the
			// line pass (after pretty-code renames the pre, it lives on the figure)
			if (meta.linenosOff) {
				const classList = Array.isArray(node.properties?.className)
					? node.properties.className
					: [];
				node.properties = { ...node.properties, className: [...classList, 'md-linenos-off'] };
			}

			if (!meta.collapsed) {
				if (meta.title) {
					parent.children.splice(index, 0, titleLine(meta.title));
					return [SKIP, index];
				}
				return;
			}

			const summary: Element = {
				type: 'element',
				tagName: 'summary',
				properties: {},
				children: [{ type: 'text', value: meta.title ?? '代码' }]
			};
			const details: Element = {
				type: 'element',
				tagName: 'details',
				properties: {
					className: ['md-code-collapsed'],
					...(typeof meta.collapsed === 'number' ? { dataMdCollapse: String(meta.collapsed) } : {})
				},
				children: [summary, node]
			};
			parent.children.splice(index, 1, details);
			return [SKIP, index];
		});
	};
};
