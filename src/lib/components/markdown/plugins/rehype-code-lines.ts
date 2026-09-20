import type { Plugin } from 'unified';
import type { Root as HastRoot, Element } from 'hast';
import { visit } from 'unist-util-visit';

/**
 * Code-block line structure and numbering (spec 3.3) — runs after
 * rehype-pretty-code (server) and after the mermaid pass on both pipelines,
 * so it sees each pipeline's final block shape:
 *
 * - pretty-code output: the lines are `<span data-line>` children of `<code>`
 * - light pipeline: the code is plain text — split here into line spans
 *
 * Every line gets `md-code-line`. The block gets `md-code-linenos` (numbers
 * render via a CSS counter) unless the info string said `linenos=off` — the
 * `md-linenos-off` marker written by the code-meta pass is consumed here
 * (after pretty-code renames the pre to a figure, the marker lives on the
 * figure, so both the pre and its parent are checked). A `collapsed=N` block
 * previews its first N lines: the rest get `md-code-line-hidden`, which the
 * stylesheet hides while the details is closed.
 */
export const rehypeCodeLines: Plugin<[], HastRoot> = () => {
	const classList = (element: Element): string[] => {
		const value = element.properties?.className;
		return Array.isArray(value)
			? value.map(String)
			: typeof value === 'string'
				? value.split(/\s+/)
				: [];
	};
	const addClass = (element: Element, name: string): void => {
		const list = classList(element);
		if (!list.includes(name))
			element.properties = { ...element.properties, className: [...list, name] };
	};
	const removeClass = (element: Element, name: string): void => {
		const list = classList(element).filter((entry) => entry !== name);
		if (element.properties) element.properties = { ...element.properties, className: list };
	};

	const ensureLines = (pre: Element): Element[] | null => {
		const code = pre.children.find(
			(child): child is Element => child.type === 'element' && child.tagName === 'code'
		);
		if (!code) return null;
		// pretty-code writes the literal `data-line` key (programmatic nodes are
		// not camelised the way parsed attributes are), so both spellings count
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
		const segments = value.split('\n');
		if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
		const lines: Element[] = segments.map((segment) => ({
			type: 'element',
			tagName: 'span',
			properties: { className: ['md-code-line'] },
			children: segment.length > 0 ? [{ type: 'text', value: segment }] : []
		}));
		code.children = lines;
		return lines;
	};

	const decorate = (
		pre: Element,
		previewLimit: number | null,
		details: Element | null,
		parent: Element | null
	): void => {
		const lines = ensureLines(pre);
		if (!lines) return;
		if (previewLimit !== null) {
			lines.forEach((line, index) => {
				if (index >= previewLimit) addClass(line, 'md-code-line-hidden');
			});
			if (details) addClass(details, 'md-code-preview');
		}
		// The parent comes from the visitor: nodes rebuilt by pretty-code are
		// created programmatically and never get a .parent pointer, so the
		// marker on the figure would go unnoticed otherwise.
		const numbered =
			!classList(pre).includes('md-linenos-off') &&
			!(parent && classList(parent).includes('md-linenos-off'));
		removeClass(pre, 'md-linenos-off');
		if (parent) removeClass(parent, 'md-linenos-off');
		if (numbered) addClass(pre, 'md-code-linenos');
	};

	return (tree) => {
		const handled = new WeakSet<Element>();
		const findPre = (root: Element): { pre: Element; parent: Element } | null => {
			if (root.tagName === 'pre') return { pre: root, parent: root };
			for (const child of root.children) {
				if (child.type !== 'element') continue;
				if (child.tagName === 'pre') return { pre: child, parent: root };
				for (const grand of child.children) {
					if (grand.type === 'element' && grand.tagName === 'pre') {
						return { pre: grand, parent: child };
					}
				}
			}
			return null;
		};
		// collapsed=N previews first (they live inside the details wrapper)
		visit(tree, 'element', (node: Element) => {
			if (node.tagName !== 'details') return;
			const raw = node.properties?.dataMdCollapse;
			const limit = Number.parseInt(String(raw ?? ''), 10);
			if (!Number.isInteger(limit) || limit <= 0) return;
			const found = findPre(node);
			if (!found) return;
			decorate(found.pre, limit, node, found.parent);
			handled.add(found.pre);
		});
		// every other code block: numbering only
		visit(tree, 'element', (node: Element, _index, parentNode) => {
			if (node.tagName !== 'pre' || handled.has(node)) return;
			if (classList(node).includes('mermaid')) return;
			decorate(node, null, null, parentNode && parentNode.type === 'element' ? parentNode : null);
		});
	};
};
