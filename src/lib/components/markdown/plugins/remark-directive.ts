import type { Plugin } from 'unified';
import type { Root, Paragraph } from 'mdast';
import { visit } from 'unist-util-visit';
import type { ContainerDirective } from 'mdast-util-directive';

/**
 * Directive containers (spec 3.2) — the closed registry is
 * `grid | tabs | tab | details`, plus the `spoiler` block-spoiler sugar that
 * renders as `<details>`. Unregistered names keep their content and warn once
 * (spec 5). Retired with batch 4a (render side): gallery, banner. The
 * alignment directives (left/center/right/justify) still take their own
 * branch until batch 4b retires them together with the editor side.
 *
 * Every container renders through hName/hProperties only — this plugin never
 * builds raw HTML strings. The provenance pass
 * (rehype-raw-html-whitelist.ts) relies on pipeline output being regular hast
 * nodes; a raw-HTML string would be re-parsed by rehype-raw and lose its
 * pipeline origin.
 */

type Attributes = ContainerDirective['attributes'];

/** Grid parameters (spec 3.2): closed key set, enumerable value sets. */
const GRID_KEYS = new Set(['cols', 'rows', 'gap', 'layout', 'type']);
const GRID_COLS = new Set(['1', '2', '3', '4', '5', '6']);
const GRID_GAPS = new Set(['0', '4', '8', '12', '16']);
const GRID_LAYOUTS = new Set(['grid', 'masonry', 'carousel']);
const GRID_TYPES = new Set(['normal', 'images']);

/** Closed attribute key sets of the other containers (spec 3.2). */
const DETAILS_KEYS = new Set(['summary', 'open']);
const SPOILER_KEYS = new Set(['label']);
const TAB_KEYS = new Set(['label']);
const TABS_KEYS = new Set<string>([]);

/**
 * Warnings are logged once per cause and capped in total: SSR renders the
 * same tree repeatedly, and the dedupe keys can contain author-provided text
 * (container names, parameter values), so an unbounded set would let a
 * hostile document grow memory and log volume.
 */
const WARN_LIMIT = 100;
const warnedKeys = new Set<string>();
function warnOnce(key: string, message: string): void {
	if (warnedKeys.has(key) || warnedKeys.size >= WARN_LIMIT) return;
	warnedKeys.add(key);
	console.warn(`[markdown] ${message}`);
}

function warnUnknownKeys(name: string, allowed: Set<string>, attributes: Attributes): void {
	for (const key of Object.keys(attributes ?? {})) {
		if (!allowed.has(key)) {
			warnOnce(`${name}-key:${key}`, `${name}: unknown parameter "${key}" ignored (spec 3.2)`);
		}
	}
}

interface GridParamSpec {
	key: string;
	prop: string;
	values?: Set<string>;
	pattern?: RegExp;
	label: string;
}

const GRID_PARAMS: GridParamSpec[] = [
	{ key: 'cols', prop: 'dataCols', values: GRID_COLS, label: 'supported set 1-6' },
	{ key: 'rows', prop: 'dataRows', pattern: /^\d+$/, label: 'row-count form' },
	{ key: 'gap', prop: 'dataGap', values: GRID_GAPS, label: 'supported set 0/4/8/12/16' },
	{
		key: 'layout',
		prop: 'dataLayout',
		values: GRID_LAYOUTS,
		label: 'supported set grid/masonry/carousel'
	},
	{ key: 'type', prop: 'dataType', values: GRID_TYPES, label: 'supported set normal/images' }
];

/** Validates grid parameters and returns the hast properties for the wrapper. */
function gridProperties(attributes: Attributes): Record<string, unknown> {
	const props: Record<string, unknown> = {};
	warnUnknownKeys('grid', GRID_KEYS, attributes);
	for (const spec of GRID_PARAMS) {
		const value = attributes?.[spec.key];
		if (value == null) continue;
		const valid = spec.values ? spec.values.has(value) : spec.pattern!.test(value);
		if (valid) {
			props[spec.prop] = value;
		} else {
			warnOnce(
				`grid-${spec.key}:${value}`,
				`grid: "${spec.key}=${value}" is outside the ${spec.label} — falling back to the default`
			);
		}
	}
	return props;
}

/** A paragraph that renders as `tag`, optionally carrying a class. */
function labelParagraph(tag: 'summary' | 'p', className: string | null, value: string): Paragraph {
	return {
		type: 'paragraph',
		data: {
			hName: tag,
			...(className ? { hProperties: { className: [className] } } : {})
		},
		children: [{ type: 'text', value }]
	};
}

export const remarkContainerDirective: Plugin<[], Root> = () => {
	return (tree, file) => {
		const source = String(file.value ?? '');

		visit(tree, (node, index, parent) => {
			// Unregistered text/leaf directives are restored to their literal
			// source. The closed L2 set has no text/leaf directives at all
			// (spec 2), and micromark-extension-directive otherwise happily parses
			// a bare `:word` out of ordinary prose (`12:30`, `说明:内容`) into an
			// unrendered node — which silently swallowed the text after the colon
			// (spec 5: content is never swallowed).
			if (node.type === 'textDirective' || node.type === 'leafDirective') {
				if (!parent || index == null) return;
				// Parsed directives always carry positions; the guard is defensive.
				const { start, end } = node.position ?? {};
				if (start?.offset == null || end?.offset == null) return;
				const literal = { type: 'text' as const, value: source.slice(start.offset, end.offset) };
				const replacement = (node.type === 'leafDirective'
					? // leaf directives sit at block level, so keep a paragraph
						{ type: 'paragraph', children: [literal] }
					: literal) as unknown as { type: string };
				// `parent.children` is a union of node lists (root / phrasing / table
				// cell ...), which defeats the overloaded splice; mutate through a
				// widened view instead.
				(parent.children as unknown as Array<{ type: string }>).splice(index, 1, replacement);
				return index + 1;
			}

			if (node.type !== 'containerDirective' || !parent || index == null) return;

			const directive = node as unknown as ContainerDirective;
			const name = directive.name;
			const attributes = directive.attributes;

			// Alignment directives are retired in batch 4b; until then they take
			// this branch. Note their style is stripped by the sanitize schema
			// (div@style is not allowed), so the render is already a no-op today.
			if (['left', 'center', 'right', 'justify'].includes(name)) {
				const data = directive.data ?? (directive.data = {});
				data.hName = 'div';
				data.hProperties = { style: `text-align: ${name};` };
				return;
			}

			if (name === 'grid') {
				const data = directive.data ?? (directive.data = {});
				data.hName = 'div';
				data.hProperties = { className: ['md-grid'], ...gridProperties(attributes) };
				return;
			}

			if (name === 'tabs') {
				warnUnknownKeys('tabs', TABS_KEYS, attributes);
				const strayChild = directive.children.some(
					(child) =>
						child.type !== 'containerDirective' ||
						(child as unknown as ContainerDirective).name !== 'tab'
				);
				if (strayChild) {
					warnOnce(
						'tabs-stray-child',
						'tabs: only ":::tab" children are defined (spec 3.2) — other blocks render in place'
					);
				}
				const data = directive.data ?? (directive.data = {});
				data.hName = 'div';
				data.hProperties = { className: ['md-tabs'] };
				return;
			}

			if (name === 'tab') {
				const insideTabs =
					parent.type === 'containerDirective' &&
					(parent as unknown as ContainerDirective).name === 'tabs';
				if (!insideTabs) {
					warnOnce(
						'tab-outside-tabs',
						'tab: ":::tab" is only valid inside ":::tabs" — rendered as a plain container (spec 3.2)'
					);
					return;
				}
				warnUnknownKeys('tab', TAB_KEYS, attributes);
				const label = String(attributes?.label ?? '').trim();
				const data = directive.data ?? (directive.data = {});
				data.hName = 'div';
				data.hProperties = {
					className: ['md-tab'],
					...(label ? { dataLabel: label } : {})
				};
				if (label) {
					directive.children.unshift(labelParagraph('p', 'md-tab-label', label));
				}
				return;
			}

			if (name === 'details' || name === 'spoiler') {
				const spoiler = name === 'spoiler';
				warnUnknownKeys(name, spoiler ? SPOILER_KEYS : DETAILS_KEYS, attributes);
				const summary = spoiler
					? String(attributes?.label ?? '').trim() || '剧透'
					: String(attributes?.summary ?? '').trim() || '详情';
				const open = !spoiler && attributes != null && 'open' in attributes;
				const data = directive.data ?? (directive.data = {});
				data.hName = 'details';
				data.hProperties = {
					className: spoiler ? ['md-details', 'md-spoiler'] : ['md-details'],
					...(open ? { open: true } : {})
				};
				directive.children.unshift(labelParagraph('summary', null, summary));
				return;
			}

			// Unregistered container: keep the content, warn once (spec 5).
			warnOnce(
				`container:${name}`,
				`unregistered container directive ":::${name}" — opening line ignored, content kept (spec 5)`
			);
		});
	};
};
