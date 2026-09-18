import type { Plugin } from 'unified';
import type { Root as HastRoot, Element } from 'hast';
import { visit, SKIP } from 'unist-util-visit';

/**
 * Raw-HTML governance (spec 4.5) — two cooperating plugins:
 *
 * 1. rehypeMarkMdastImages (before rehype-raw): tags the img elements produced
 *    by the markdown `!` syntax (raw-HTML imgs carry no tag).
 * 2. rehypeRawHtmlWhitelist (after rehype-raw): does the two things
 *    rehype-sanitize cannot:
 *    - img provenance filter: keep only `!`-syntax output; a raw `<img>` is
 *      removed together with its content (sanitize cannot tell the sources
 *      apart) — `!` is the only image entry point
 *    - script/style/iframe/template are removed with their content: sanitize
 *      *unwraps* non-whitelisted elements and keeps their text, which would
 *      leak script code or CSS into the body text; these must go entirely
 *
 * All other 4.5 whitelist/blacklist element and attribute filtering is done by
 * buildSanitizeSchema (rehype-sanitize is the last line of defence). No mdast
 * syntax produces those five elements, so this filter cannot harm the
 * pipeline's own output.
 */

/** Elements removed together with their content */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'template']);

/** Provenance flag key (on the hast properties object) */
const PROVENANCE = 'dataMdImage';

export const rehypeMarkMdastImages: Plugin<[], HastRoot> = () => {
	return (tree) => {
		visit(tree, 'element', (node: Element) => {
			if (node.tagName === 'img') {
				node.properties = { ...node.properties, [PROVENANCE]: '1' };
			}
		});
	};
};

export const rehypeRawHtmlWhitelist: Plugin<[], HastRoot> = () => {
	return (tree) => {
		visit(
			tree,
			'element',
			(node: Element, index, parent): boolean | typeof SKIP | [typeof SKIP, number] | void => {
				const tag = node.tagName;

				if (DROP_WITH_CONTENT.has(tag)) {
					if (parent && index != null) {
						parent.children.splice(index, 1);
						return [SKIP, index];
					}
					return SKIP;
				}

				if (tag === 'img') {
					const fromMarkdown = node.properties?.[PROVENANCE] === '1';
					delete node.properties?.[PROVENANCE];
					if (!fromMarkdown && parent && index != null) {
						parent.children.splice(index, 1);
						return [SKIP, index];
					}
				}
			}
		);
	};
};
