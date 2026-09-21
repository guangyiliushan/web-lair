/**
 * Batch D transformers: the `::::tabs` (+ `:::tab{…}`) and `:::grid{…}`
 * containers (spec 3.2; v0.3.2 delta #4: brace attributes with zero
 * whitespace, and an outer fence one colon deeper than its children).
 *
 * Grid keys mirror the render registry (`cols` 1..6, `gap` in {0,4,8,12,16},
 * `rows` passthrough, `layout`, `type`); only the keys written in the source
 * are re-emitted, so untouched documents round-trip byte-stable. Bodies are
 * nested-editor JSON through the alert helpers.
 */
import type { MultilineElementTransformer } from '@lexical/markdown';
import { TabsNode, $createTabsNode, $isTabsNode } from '$lib/components/markdown/tabs/tabs-node';
import type { SerializedTabEntry } from '$lib/components/markdown/tabs/tabs-node';
import { GridNode, $createGridNode, $isGridNode } from '$lib/components/markdown/grid/grid-node';
import {
	alertJsonToMarkdown,
	markdownToAlertJson
} from '$lib/components/markdown/editor/markdown-transformers';

const NL = String.fromCharCode(10);

// ── tabs / tab ──

const TABS_START = /^::::tabs\s*$/;
const TAB_START = /^:::tab(?:\{(.*)\})?\s*$/;
const TAB_CLOSE = /^:::\s*$/;
const TABS_CLOSE = /^::::\s*$/;

function parseTabLabel(raw: string | undefined): { label: string; labelExplicit: boolean } {
	if (raw === undefined) return { label: '', labelExplicit: false };
	const quoted = /label\s*=\s*"([^"]*)"/.exec(raw);
	return { label: (quoted?.[1] ?? '').trim(), labelExplicit: quoted !== null };
}

export const tabsTransformer: MultilineElementTransformer = {
	dependencies: [TabsNode],
	regExpStart: TABS_START,
	regExpEnd: { regExp: TABS_CLOSE, optional: true },
	handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
		const tabs: SerializedTabEntry[] = [];
		let i = startLineIndex + 1;
		while (i < lines.length && !TABS_CLOSE.test(lines[i] ?? '')) {
			const tabMatch = TAB_START.exec(lines[i] ?? '');
			if (!tabMatch) return null; // stray content: not a registry shape
			const { label, labelExplicit } = parseTabLabel(tabMatch[1]);
			const body: string[] = [];
			i++;
			while (
				i < lines.length &&
				!TAB_CLOSE.test(lines[i] ?? '') &&
				!TAB_START.test(lines[i] ?? '') &&
				!TABS_CLOSE.test(lines[i] ?? '')
			) {
				body.push(lines[i] ?? '');
				i++;
			}
			if (i >= lines.length || !TAB_CLOSE.test(lines[i] ?? '')) return null;
			i++; // consume the tab's closing :::
			tabs.push({ label, labelExplicit, jsonContent: markdownToAlertJson(body.join(NL).trim()) });
		}
		if (i >= lines.length || tabs.length === 0) return null;
		rootNode.append($createTabsNode(tabs));
		return [true, i];
	},
	replace: () => false,
	export: (node) => {
		if (!$isTabsNode(node)) return null;
		const parts: string[] = ['::::tabs'];
		for (const tab of node.getTabs()) {
			parts.push(tab.labelExplicit ? ':::tab{label="' + tab.label + '"}' : ':::tab');
			const inner = alertJsonToMarkdown(tab.jsonContent);
			if (inner) parts.push(inner);
			parts.push(':::');
		}
		parts.push('::::');
		return parts.join(NL);
	},
	type: 'multiline-element'
};

// ── grid ──

const GRID_START = /^:::grid(?:\{(.*)\})?\s*$/;
const GRID_KEYS = ['cols', 'rows', 'gap', 'layout', 'type'] as const;
const GRID_COLS_MIN = 1;
const GRID_COLS_MAX = 6;
const GRID_GAPS = new Set([0, 4, 8, 12, 16]);

interface GridParams {
	cols: number;
	rows: number | null;
	gap: number;
	layout: 'grid' | 'masonry' | 'carousel';
	imageType: 'normal' | 'images';
	explicit: string[];
}

function parseGridParams(raw: string): GridParams {
	const out: GridParams = {
		cols: 3,
		rows: null,
		gap: 8,
		layout: 'grid',
		imageType: 'normal',
		explicit: []
	};
	for (const pair of raw.trim().split(/\s+/)) {
		const [key, value] = pair.split('=');
		if (!key || value === undefined || !(GRID_KEYS as readonly string[]).includes(key)) continue;
		if (key === 'cols' && /^\d+$/.test(value)) {
			const n = parseInt(value, 10);
			if (n >= GRID_COLS_MIN && n <= GRID_COLS_MAX) {
				out.cols = n;
				out.explicit.push(key);
			}
		} else if (key === 'rows' && /^\d+$/.test(value)) {
			out.rows = parseInt(value, 10);
			out.explicit.push(key);
		} else if (key === 'gap' && /^\d+$/.test(value) && GRID_GAPS.has(parseInt(value, 10))) {
			out.gap = parseInt(value, 10);
			out.explicit.push(key);
		} else if (
			key === 'layout' &&
			(value === 'grid' || value === 'masonry' || value === 'carousel')
		) {
			out.layout = value;
			out.explicit.push(key);
		} else if (key === 'type' && (value === 'normal' || value === 'images')) {
			out.imageType = value;
			out.explicit.push(key);
		}
	}
	return out;
}

export const gridTransformer: MultilineElementTransformer = {
	dependencies: [GridNode],
	regExpStart: GRID_START,
	regExpEnd: { regExp: /^:::\s*$/, optional: true },
	handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
		const match = GRID_START.exec(lines[startLineIndex] ?? '');
		if (!match) return null;
		const rawAttrs = match[1] ?? '';
		const params = parseGridParams(rawAttrs);
		const body: string[] = [];
		let i = startLineIndex + 1;
		while (i < lines.length && !/^:::\s*$/.test(lines[i] ?? '')) {
			body.push(lines[i] ?? '');
			i++;
		}
		if (i >= lines.length) return null;
		rootNode.append(
			$createGridNode(
				rawAttrs,
				params.cols,
				params.rows,
				params.gap,
				params.layout,
				params.imageType,
				params.explicit,
				markdownToAlertJson(body.join(NL).trim())
			)
		);
		return [true, i];
	},
	replace: () => false,
	export: (node) => {
		if (!$isGridNode(node)) return null;
		// source fidelity: re-emit the brace content exactly as written
		const raw = node.getRawAttrs();
		const header = ':::grid' + (raw ? '{' + raw + '}' : '');
		const inner = alertJsonToMarkdown(node.getJsonContent());
		if (!inner) return header + NL + ':::';
		return header + NL + inner + NL + ':::';
	},
	type: 'multiline-element'
};
