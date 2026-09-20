import type { Plugin } from 'unified';
import type { Root, Code } from 'mdast';
import { visit } from 'unist-util-visit';
import { warnOnce } from './plugin-warnings';

/**
 * Code-fence info strings (spec 3.3): ```ts {collapsed=10 title="…" linenos=off}
 *
 * Closed key set: `collapsed` (bare = fully collapsed, `=N` = collapse to line
 * N), `linenos=off` (line numbers render by default — spec 3.3 defines this
 * key as the opt-out) and `title="…"`; whitespace before a brace block is allowed
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
	/** `linenos=off`: the renderer numbers lines by default (spec 3.3). */
	linenosOff?: boolean;
}

const BRACE_REGEX = /\s*\{([^}]*)\}/g;
/** Upper bound for `collapsed=N`; beyond it the fence meta is rejected. */
const MAX_COLLAPSE_LINES = 9999;
const TITLE_REGEX = /title="([^"]*)"/;

export const remarkCodeMeta: Plugin<[], Root> = () => {
	return (tree) => {
		visit(tree, 'code', (node: Code) => {
			const meta = node.meta ?? '';
			const blocks = [...meta.matchAll(BRACE_REGEX)];
			// Anything outside the brace blocks is not part of the closed key set.
			// Strip it before the early return: leaving it in node.meta hands it
			// to rehype-pretty-code, which renders server-only captions (a
			// double-pipeline drift).
			const leftover = meta.replace(BRACE_REGEX, '').trim();
			if (leftover) {
				warnOnce(
					`code-meta-bare:${leftover}`,
					`code: info-string keys outside the brace block are ignored (spec 3.3): "${leftover}"`
				);
			}
			node.meta = '';
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
						if (
							/^\d+$/.test(rawValue) &&
							Number.isSafeInteger(line) &&
							line > 0 &&
							line <= MAX_COLLAPSE_LINES
						)
							parsed.collapsed = line;
						else
							warnOnce(
								`code-meta-collapsed:${token}`,
								`code: "${token}" is not a line count — ignored (spec 3.3)`
							);
					} else if (token === 'linenos=off') {
						parsed.linenosOff = true;
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
		});
	};
};
