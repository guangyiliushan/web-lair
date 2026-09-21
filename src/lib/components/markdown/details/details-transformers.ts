/**
 * Batch D transformers: the `:::details{…}` / `:::spoiler{…}` containers
 * (spec 3.2; v0.3.2 delta #4: the opening line is the name directly followed
 * by the brace block, zero whitespace). Attribute keys are variant-strict
 * (`summary`/`open` for details, `label` for spoiler); unknown keys are
 * ignored like the render registry does.
 */
import type { MultilineElementTransformer } from '@lexical/markdown';
import { DetailsNode, $createDetailsNode, $isDetailsNode } from './details-node';
import type { DetailsVariant } from './details-node';
import {
	alertJsonToMarkdown,
	markdownToAlertJson
} from '$lib/components/markdown/editor/markdown-transformers';

const NL = String.fromCharCode(10);
const OPEN_START = /^:::(details|spoiler)(?:\{(.*)\})?\s*$/;
const CLOSE = /^:::\s*$/;

function parseAttributes(
	variant: DetailsVariant,
	raw: string
): { summary: string; summaryExplicit: boolean; open: boolean } {
	if (variant === 'details') {
		const quoted = /summary\s*=\s*"([^"]*)"/.exec(raw);
		return {
			summary: (quoted?.[1] ?? '').trim(),
			summaryExplicit: quoted !== null,
			// quoted values are opaque: strip them before scanning for the bare word
			open: /(?:^|\s)open(?:\s|$|=)/.test(raw.replace(/"[^"]*"/g, '""').trim())
		};
	}
	const quoted = /label\s*=\s*"([^"]*)"/.exec(raw);
	return { summary: (quoted?.[1] ?? '').trim(), summaryExplicit: quoted !== null, open: false };
}

export const detailsTransformer: MultilineElementTransformer = {
	dependencies: [DetailsNode],
	regExpStart: OPEN_START,
	regExpEnd: { regExp: CLOSE, optional: true },
	handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
		const match = OPEN_START.exec(lines[startLineIndex] ?? '');
		if (!match) return null;
		const variant = match[1] as DetailsVariant;
		const rawAttrs = match[2] ?? '';
		const { summary, summaryExplicit, open } = parseAttributes(variant, rawAttrs);
		const body: string[] = [];
		let i = startLineIndex + 1;
		while (i < lines.length && !CLOSE.test(lines[i] ?? '')) {
			body.push(lines[i] ?? '');
			i++;
		}
		if (i >= lines.length) return null; // unclosed: keep the source literal
		rootNode.append(
			$createDetailsNode(
				variant,
				rawAttrs,
				summary,
				summaryExplicit,
				open,
				markdownToAlertJson(body.join(NL).trim())
			)
		);
		return [true, i];
	},
	replace: () => false,
	export: (node) => {
		if (!$isDetailsNode(node)) return null;
		// source fidelity: re-emit the brace content exactly as written
		const raw = node.getRawAttrs();
		const header = ':::' + node.getVariant() + (raw ? '{' + raw + '}' : '');
		const inner = alertJsonToMarkdown(node.__jsonContent);
		if (!inner) return header + NL + ':::';
		return header + NL + inner + NL + ':::';
	},
	type: 'multiline-element'
};
