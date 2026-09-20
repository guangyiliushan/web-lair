import type { Plugin } from 'unified';
import type { Root, Code } from 'mdast';
import { visit } from 'unist-util-visit';
import { warnOnce } from './plugin-warnings';

/**
 * Code-fence info strings (spec 3.3): ```ts {collapsed=10 title="…" linenos=off}
 *
 * Closed key set: `collapsed` (bare = fully collapsed, `=N` = collapse to line
 * N), `linenos=off` (accepted — the renderer has no line numbers yet, nothing
 * to turn off) and `title="…"`; whitespace before a brace block is allowed
 * (the spec example uses it). Unknown keys warn once.
 *
 * EVERY brace block is consumed: parsing only the first one would leave a
 * second block in the node's meta, where rehype-pretty-code turns it into a
 * server-only caption — a double-pipeline drift.
 *
 * The parsed meta rides to hast as a JSON string in
 * `hProperties.dataMdCodeMeta` (mdast `data` payloads do not survive the
 * transform); the rehype side consumes it before rehype-raw runs.
 */

/** Transport property carrying the parsed meta from mdast to hast (shared). */
export const META_ATTR = 'dataMdCodeMeta';

export interface CodeMeta {
	/** false = expanded; true = all collapsed; number = collapse to line N. */
	collapsed: true | number | false;
	title?: string;
}

const BRACE_REGEX = /\s*\{([^}]*)\}/g;
const TITLE_REGEX = /title="([^"]*)"/;

export const remarkCodeMeta: Plugin<[], Root> = () => {
	return (tree) => {
		visit(tree, 'code', (node: Code) => {
			const meta = node.meta ?? '';
			const blocks = [...meta.matchAll(BRACE_REGEX)];
			if (blocks.length === 0) return;

			const parsed: CodeMeta = { collapsed: false };
			for (const block of blocks) {
				let rest = block[1];
				const titleMatch = TITLE_REGEX.exec(rest);
				if (titleMatch) {
					if (titleMatch[1]) parsed.title = titleMatch[1];
					rest = rest.replace(titleMatch[0], '');
				}
				for (const token of rest.trim().split(/\s+/).filter(Boolean)) {
					if (token === 'collapsed') {
						parsed.collapsed = true;
					} else if (token.startsWith('collapsed=')) {
						const rawValue = token.slice('collapsed='.length);
						const line = Number(rawValue);
						if (/^\d+$/.test(rawValue) && line > 0) parsed.collapsed = line;
						else
							warnOnce(
								`code-meta-collapsed:${token}`,
								`code: "${token}" is not a line count — ignored (spec 3.3)`
							);
					} else if (token === 'linenos=off') {
						// accepted; the renderer shows no line numbers yet (recorded)
					} else {
						warnOnce(
							`code-meta:${token}`,
							`code: unknown info-string key "${token}" ignored (spec 3.3)`
						);
					}
				}
			}

			node.data = {
				...(node.data ?? {}),
				hProperties: { ...(node.data?.hProperties ?? {}), [META_ATTR]: JSON.stringify(parsed) }
			};
			node.meta = meta.replace(BRACE_REGEX, '').trim();
		});
	};
};
