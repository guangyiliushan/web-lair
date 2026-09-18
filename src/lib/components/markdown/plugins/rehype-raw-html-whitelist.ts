import type { Plugin } from 'unified';
import type { Root as HastRoot, Element, RootContent } from 'hast';
import { visit, SKIP } from 'unist-util-visit';

/**
 * Raw-HTML governance (spec 4.5) — two cooperating plugins around rehype-raw:
 *
 * 1. rehypeMarkPipelineNodes (before rehype-raw): stamps every element with a
 *    runtime provenance token. hast attributes survive rehype-raw's parse5
 *    round-trip on the same element (the img provenance shipped since batch 2
 *    relies on exactly this), so after the reparse the token still identifies
 *    the elements this pipeline produced.
 * 2. rehypeRawHtmlWhitelist (after rehype-raw): splits pipeline output from
 *    author-written raw HTML:
 *    - pipeline elements: kept; rehype-sanitize still runs last
 *    - raw elements: the 4.5 closed set applies — elements outside the set
 *      are unwrapped with their text kept (5), script/style/iframe/template
 *      and img are removed with their content, and attributes are reduced to
 *      the per-tag whitelist plus the global `id`.
 *
 * The token is random per module load and never reaches the output (both
 * passes here only read it; a final pass strips it, and it is not part of the
 * sanitize schema either). An author-written `data-md-x` cannot match it — a
 * constant marker can be forged byte-for-byte (probe evidence, batch 4),
 * which is exactly why this is random.
 */

const PROVENANCE_KEY = 'dataMdX';

/**
 * Runtime token. `crypto.randomUUID` is the strong source where available
 * (secure contexts); the fallback keeps non-secure deployments working — the
 * token is never emitted, so unpredictability beyond this is not required.
 */
const PROVENANCE_TOKEN = (() => {
	const rand =
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
	return `md${rand}`;
})();

/** Removed together with their content (spec 4.5: no allow path exists). */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'template']);

/**
 * The spec 4.5 closed set for raw HTML. `img` is intentionally absent: the
 * `!` syntax is the only image entry point.
 */
const RAW_ALLOWED = new Set([
	'kbd',
	'mark',
	'ins',
	'del',
	'sub',
	'sup',
	'abbr',
	'tag',
	'details',
	'summary',
	'figure',
	'figcaption',
	'video',
	'audio',
	'source',
	'time'
]);

/** Per-tag attribute whitelists for raw elements (spec 4.5 + plan extensions). */
const RAW_ATTRS: Record<string, readonly string[]> = {
	video: ['src', 'poster', 'width', 'height', 'muted', 'loop', 'preload'],
	audio: ['src', 'width', 'height', 'muted', 'loop', 'preload'],
	source: ['src', 'type'],
	details: ['open'],
	time: ['datetime'],
	abbr: ['title']
};

/** Per-tag attr sets, precomputed once (the filter runs per element). */
const RAW_ATTR_SETS = new Map<string, Set<string>>(
	Object.entries(RAW_ATTRS).map(([tag, list]) => [tag, new Set(list)])
);
const NO_RAW_ATTRS: ReadonlySet<string> = new Set();

export const rehypeMarkPipelineNodes: Plugin<[], HastRoot> = () => {
	return (tree) => {
		visit(tree, 'element', (node: Element) => {
			// The tree is freshly built here, so mutating in place is safe.
			if (node.properties) node.properties[PROVENANCE_KEY] = PROVENANCE_TOKEN;
			else node.properties = { [PROVENANCE_KEY]: PROVENANCE_TOKEN };
		});
	};
};

export const rehypeRawHtmlWhitelist: Plugin<[], HastRoot> = () => {
	return (tree) => {
		// Pass 1 — classify by the token and enforce 4.5 on raw elements. The
		// token is only ever READ here: unwrapping relocates children, and the
		// walker can then reach a node again with a stale position. A decision
		// that deleted its own evidence would not be idempotent — the second
		// visit would re-classify pipeline output as raw and drop it (the
		// batch-4a review's data-loss reproducer).
		visit(tree, 'element', (node, index, parent) => {
			if (node.properties?.[PROVENANCE_KEY] === PROVENANCE_TOKEN) return;

			const tag = node.tagName;

			if (DROP_WITH_CONTENT.has(tag) || tag === 'img') {
				if (parent && index != null && parent.children[index] === node) {
					parent.children.splice(index, 1);
					return [SKIP, index];
				}
				return SKIP;
			}

			if (!RAW_ALLOWED.has(tag)) {
				// Unwrap: keep the children so text is never swallowed (5). The
				// membership guard keeps a revisit with a stale position from
				// splicing an innocent sibling.
				if (parent && index != null && parent.children[index] === node) {
					parent.children.splice(index, 1, ...(node.children as RootContent[]));
					return index;
				}
				return;
			}

			const allowed = RAW_ATTR_SETS.get(tag) ?? NO_RAW_ATTRS;
			for (const key of Object.keys(node.properties ?? {})) {
				if (key !== 'id' && !allowed.has(key)) delete node.properties?.[key];
			}
		});

		// Pass 2 — the stamp never reaches the output; forged values go with it
		// (no legitimate consumer exists past this filter).
		visit(tree, 'element', (node: Element) => {
			delete node.properties?.[PROVENANCE_KEY];
		});
	};
};
