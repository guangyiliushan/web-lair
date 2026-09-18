import type { Plugin } from 'unified';
import type { Root as HastRoot, Element, ElementContent } from 'hast';
import { visit } from 'unist-util-visit';
import { warnOnce } from './plugin-warnings';

/**
 * Heading ids, slugs and anchor links (spec 3.6).
 *
 * Runs AFTER rehype-sanitize on purpose: the sanitizer clobbers `id`
 * attributes (DOM-clobbering defence) and cannot tell pipeline output from
 * raw HTML, so ids assigned before it would come out re-prefixed and every
 * in-page anchor would break. Everything produced here is derived from the
 * sanitized tree and validated locally, so running last does not reopen an
 * injection path.
 *
 * - `## 标题 {#custom-id}` (ATX tail, whitespace before `{`, valid id chars)
 *   sets the custom id and keeps the heading text clean
 * - otherwise the id is the auto slug: NFKC → strip punctuation (Unicode P,
 *   per spec wording) → whitespace runs to `-`; duplicates get `-2`, `-3`, …
 * - every heading gets an anchor link `#` (href percent-encoded) as its first
 *   child so the anchor is reachable without JavaScript
 */

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const TAIL_ID_REGEX = /[ \t]+\{#([^}]+)\}$/;
const ID_VALID_REGEX = /^[\p{L}\p{N}_-]+$/u;

/**
 * Spec 3.6 slug: NFKC → strip punctuation → whitespace runs to `-`.
 *
 * Symbols and control/format characters are stripped as well: the spec wording
 * says punctuation, but symbols (`+`, `^`, `$`, `<`) and invisible format
 * characters (U+200B, U+202E) would produce ids that are hostile to CSS
 * selectors and misleading in the UI (spec revision note, batch 8).
 */
function slugifyHeading(text: string): string {
	return text
		.normalize('NFKC')
		.replace(/[\p{P}\p{S}\p{C}]/gu, '')
		.replace(/\s+/g, '-');
}

/** First free id for `base`, registering it (`-2`, `-3`, … on duplicates). */
function uniqueId(base: string, used: Set<string>): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let suffix = 2;
	while (used.has(`${base}-${suffix}`)) suffix += 1;
	const id = `${base}-${suffix}`;
	used.add(id);
	return id;
}

/** Text content of an element (local equivalent of hast-util-to-string). */
function textContent(node: Element): string {
	let out = '';
	visit(node, (child) => {
		if (child.type === 'text') out += child.value;
	});
	return out;
}

/**
 * The heading's trailing text node. Only a TOP-LEVEL trailing text counts: a
 * `{#id}` that sits inside an inline element (link, code, emphasis) is not a
 * heading tail (spec 3.6) and must keep rendering verbatim. Setext headings
 * are indistinguishable from ATX at this layer, so they take the same path
 * (documented deviation; see the batch record).
 */
function trailingText(node: Element): { value: string } | null {
	const last = node.children[node.children.length - 1];
	return last?.type === 'text' ? last : null;
}
export const rehypeHeadingAnchors: Plugin<[], HastRoot> = () => {
	return (tree) => {
		const used = new Set<string>();

		visit(tree, 'element', (node: Element) => {
			if (!HEADING_TAGS.has(node.tagName)) return;

			let customId: string | null = null;
			const lastText = trailingText(node);
			if (lastText) {
				const match = TAIL_ID_REGEX.exec(lastText.value);
				if (match) {
					if (ID_VALID_REGEX.test(match[1])) {
						customId = match[1];
						lastText.value = lastText.value.slice(0, lastText.value.length - match[0].length);
					} else {
						warnOnce(
							`heading-id:${match[1]}`,
							`heading: "{#${match[1]}}" is not a valid id — kept as text (spec 3.6)`
						);
					}
				}
			}

			// An all-punctuation heading can slug to '' — fall back so the anchor
			// stays addressable.
			const id = uniqueId(customId ?? (slugifyHeading(textContent(node)) || 'section'), used);
			node.properties = { ...node.properties, id };
			node.children.unshift({
				type: 'element',
				tagName: 'a',
				properties: {
					className: ['md-anchor'],
					href: `#${encodeURIComponent(id)}`,
					ariaHidden: 'true',
					tabIndex: -1
				},
				children: [{ type: 'text', value: '#' }]
			} as ElementContent);
		});
	};
};
