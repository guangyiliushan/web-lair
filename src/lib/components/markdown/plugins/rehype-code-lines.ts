import type { Plugin } from 'unified';
import type { Root as HastRoot, Element } from 'hast';
import { visit } from 'unist-util-visit';
import { addClass, classList } from './hast-class';

/**
 * Code-block line structure and numbering (spec 3.3) — runs after
 * rehype-pretty-code (server) and after the mermaid pass on both pipelines,
 * so it sees each pipeline's final block shape:
 *
 * - pretty-code output: the lines are `<span data-line>` children of `<code>`
 *   (a literal `data-line` key — programmatic nodes are not camelised)
 * - light pipeline: the code is plain text — split here into line spans
 *
 * Every line gets `md-code-line`; the block gets `md-code-linenos` (numbers
 * render through a CSS counter) unless the info string said `linenos=off`.
 * Spec 3.3 defines that key as the only info-string switch, i.e. numbering is
 * on by default — an inference recorded in the spec revision notes, not spec
 * text. `linenos=off` is carried by the `md-linenos-off` marker written by
 * the code-meta pass; the marker is KEPT in the output (it is the off-state
 * evidence, keeps this pass idempotent, and after pretty-code renames the pre
 * it lives on the figure, so both the pre and its parent are checked).
 *
 * A `collapsed=N` block previews its first N lines: lines beyond N get
 * `md-code-line-hidden`, which the stylesheet hides while the details is
 * closed (keyed on `data-md-collapse`, so bare `collapsed` — full collapse —
 * is unaffected).
 */
export const rehypeCodeLines: Plugin<[], HastRoot> = () => {
	const ensureLines = (pre: Element): Element[] | null => {
		const code = pre.children.find(
			(child): child is Element => child.type === 'element' && child.tagName === 'code'
		);
		if (!code) return null;
		const existing = code.children.filter(
			(child): child is Element =>
				child.type === 'element' &&
				child.tagName === 'span' &&
				child.properties !== undefined &&
				('dataLine' in child.properties || 'data-line' in child.properties)
		);
		if (existing.length > 0) {
			for (const line of existing) addClass(line, 'md-code-line');
			return existing;
		}
		// light pipeline: plain text only — split it; anything richer is left
		// untouched (the server pipeline already produced line spans)
		if (code.children.some((child) => child.type !== 'text')) return null;
		const value = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
		const segments = value.split(/\r?\n/);
		if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
		const lines: Element[] = segments.map((segment) => ({
			type: 'element',
			tagName: 'span',
			properties: { className: ['md-code-line'] },
			// keep the newline as a text node with the span: block display comes
			// from the stylesheet, and this keeps copy/paste line-faithful
			children: [{ type: 'text', value: segment + '\n' }]
		}));
		if (lines.length === 0) return null;
		code.children = lines;
		return lines;
	};

	const findPre = (root: Element): Element | null => {
		for (const child of root.children) {
			if (child.type !== 'element') continue;
			if (child.tagName === 'pre') return child;
			for (const grand of child.children) {
				if (grand.type === 'element' && grand.tagName === 'pre') return grand;
			}
		}
		return null;
	};

	return (tree) => {
		// A single preorder pass: a details wrapper is always visited before the
		// pre it contains, so the preview limit is known by the time the pre
		// shows up — no second traversal, no bookkeeping set.
		const previewLimits = new WeakMap<Element, number>();
		visit(tree, 'element', (node: Element, _index, parentNode) => {
			if (node.tagName === 'details') {
				const limit = Number.parseInt(String(node.properties?.dataMdCollapse ?? ''), 10);
				if (!Number.isInteger(limit) || limit <= 0) return;
				const pre = findPre(node);
				if (pre) previewLimits.set(pre, limit);
				return;
			}
			if (node.tagName !== 'pre') return;
			if (classList(node).includes('mermaid')) return;
			const lines = ensureLines(node);
			if (!lines) return;
			const limit = previewLimits.get(node);
			if (limit !== undefined) {
				lines.forEach((line, index) => {
					if (index >= limit) addClass(line, 'md-code-line-hidden');
				});
			}
			const parent = parentNode && parentNode.type === 'element' ? parentNode : null;
			const numberingOff =
				classList(node).includes('md-linenos-off') ||
				(parent !== null && classList(parent).includes('md-linenos-off'));
			if (!numberingOff) addClass(node, 'md-code-linenos');
		});
	};
};
