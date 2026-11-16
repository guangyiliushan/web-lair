/**
 * Custom Markdown transformer set for the editor.
 *
 * Lexical's markdown round-trip ($convertToMarkdownString / $convertFromMarkdownString)
 * only knows nodes with a registered transformer — a custom node without one is
 * dropped by the round-trip.
 *
 * This module covers TagNode (`<tag>x</tag>`) and AlertNode (`> [!NOTE] …`):
 * - export (Lexical tree → Markdown)
 * - import (Markdown → Lexical tree)
 * - helpers converting alert-nested content between editorState JSON and Markdown
 *
 * References:
 * - https://lexical.dev/docs/packages/lexical-markdown
 * - @lexical/markdown@0.46.0 MultilineElementTransformer（regExpStart/regExpEnd/linesInBetween）
 */
import {
	createEditor,
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$isElementNode,
	$isTextNode,
	type LexicalEditor,
	type LexicalNode,
	type SerializedLexicalNode
} from 'lexical';
import {
	TRANSFORMERS,
	CHECK_LIST,
	isTableRowDivider,
	$convertFromMarkdownString,
	$convertToMarkdownString,
	type ElementTransformer,
	type MultilineElementTransformer,
	type TextMatchTransformer,
	type Transformer
} from '@lexical/markdown';
import {
	HorizontalRuleNode,
	$createHorizontalRuleNode,
	$isHorizontalRuleNode
} from '@lexical/extension';
import {
	TableNode,
	TableRowNode,
	TableCellNode,
	TableCellHeaderStates,
	$createTableNode,
	$createTableRowNode,
	$createTableCellNode,
	$isTableNode,
	$isTableRowNode,
	$isTableCellNode
} from '@lexical/table';
import {
	ImageNode,
	$createImageNode,
	$isImageNode
} from '$lib/components/markdown/image/image-node';
import { TagNode, $createTagNode, $isTagNode } from '$lib/components/markdown/tag/tag-node';
import {
	SpoilerNode,
	$createSpoilerNode,
	$isSpoilerNode
} from '$lib/components/markdown/spoiler/spoiler-node';
import {
	MentionNode,
	$createMentionNode,
	$isMentionNode
} from '$lib/components/markdown/mention/mention-node';
import {
	AlertNode,
	$createAlertNode,
	$isAlertNode
} from '$lib/components/markdown/alert/alert-node';
import {
	mathInlineTransformer,
	mathParenTransformer,
	mathBlockTransformer
} from '$lib/components/markdown/math/math-transformers';
import {
	footnoteRefTransformer,
	footnoteInlineTransformer
} from '$lib/components/markdown/footnote/footnote-transformers';
import { decideImage } from '$lib/components/markdown/embed/resolve';
import { $createEmbedNode } from '$lib/components/markdown/embed/embed-node';
import {
	embedTransformer,
	mermaidTransformer
} from '$lib/components/markdown/editor/embed-mermaid-transformers';
import { detailsTransformer } from '$lib/components/markdown/details/details-transformers';
import {
	tabsTransformer,
	gridTransformer
} from '$lib/components/markdown/grid/container-transformers';
import { parseAlertMarker } from '$lib/components/markdown/alert/alert-types';
import { EDITOR_THEME, NESTED_EDITOR_NODES } from '$lib/components/markdown/editor/editor-shared';

// ── Tag: `<tag>x</tag>` ↔ TagNode (4.5 whitelist element) ──

/**
 * Inline tag transformer.
 *
 * Spec v0.3 retires the `#content#` syntax (the "explicitly absent" list of
 * spec 2) in favour of the 4.5 whitelist `<tag>` inline element; the render
 * side keeps it through the raw-HTML whitelist and the site layer (L3) styles
 * it with element selectors.
 */
export const tagTransformer: TextMatchTransformer = {
	dependencies: [TagNode],
	importRegExp: /<tag>([^<]+)<\/tag>/,
	regExp: /<tag>([^<]+)<\/tag>$/,
	trigger: '>',
	replace: (textNode, match) => {
		// inline code binds tighter than text-match transformers (4.2)
		if (textNode.hasFormat('code')) return;
		const tagNode = $createTagNode(match[1]);
		textNode.replace(tagNode);
	},
	export: (node) => {
		if (!$isTagNode(node)) return null;
		return `<tag>${node.getTextContent()}</tag>`;
	},
	type: 'text-match'
};

// ── Spoiler: `||x||` ↔ SpoilerNode (2 #6) ──

/** Import form: run-guarded (no `|`/escape adjacent), non-space flanking. */
const SPOILER_IMPORT = /(?<![|\\])[|]{2}(?=\S)([^|]*?\S)[|]{2}(?![|])/;
const SPOILER_LIVE = /(?<![|\\])[|]{2}(?=\S)([^|]*?\S)[|]{2}(?![|])$/;

export const spoilerTransformer: TextMatchTransformer = {
	dependencies: [SpoilerNode],
	importRegExp: SPOILER_IMPORT,
	regExp: SPOILER_LIVE,
	trigger: '|',
	replace: (textNode, match) => {
		if (textNode.hasFormat('code')) return;
		// Inverse of exportFormat's escaping, keeping the round trip stable.
		const inner = match[1].replace(/\\([*_`~\\])/g, '$1');
		const node = $createSpoilerNode(inner);
		node.setFormat(textNode.getFormat());
		textNode.replace(node);
	},
	export: (node, _exportChildren, exportFormat) => {
		if (!$isSpoilerNode(node)) return null;
		// Canonical serialization: exportFormat applies the core's escaping,
		// code-span delimiters and nest order, matching what the render side
		// expects (batch A review, F3). Formatted spoilers still re-import
		// without their formats — registered, see batch-A review register.
		return '||' + exportFormat(node, node.getTextContent()) + '||';
	},
	type: 'text-match'
};

// ── Mention: `@gh:user` ↔ MentionNode (2 #4) ──

/** Boundary: line start, whitespace or punctuation (render-side mirror). The
 * escape guard intentionally over-blocks a spaced backslash (`\ \@`) — registered. */
const MENTION_IMPORT = /(?<!\\)(?<=^|[\s\p{P}\p{S}])@(?:gh|tw|tg):[A-Za-z0-9_]{1,40}/u;
/** Live form commits on the terminator space, which replace() re-inserts. */
const MENTION_LIVE = /(?<!\\)(?<=^|[\s\p{P}\p{S}])@(?:gh|tw|tg):[A-Za-z0-9_]{1,40} $/u;

export const mentionTransformer: TextMatchTransformer = {
	dependencies: [MentionNode],
	importRegExp: MENTION_IMPORT,
	regExp: MENTION_LIVE,
	trigger: ' ',
	replace: (textNode, match) => {
		if (textNode.hasFormat('code')) return;
		// the live form commits on a space; the import form must not gain one
		const terminator = match[0].endsWith(' ') ? ' ' : '';
		const node = $createMentionNode(match[0].trimEnd());
		textNode.replace(node);
		if (terminator) node.insertAfter($createTextNode(terminator));
	},
	export: (node) => ($isMentionNode(node) ? node.getTextContent() : null),
	type: 'text-match'
};

// ── HR：`---` / `***` / `___` ↔ HorizontalRuleNode ──

/**
 * Horizontal rule transformer.
 *
 * @lexical/markdown 0.46 no longer bundles an HR transformer (HorizontalRuleNode's
 * getTextContent() returns '\n'); without one $convertToMarkdownString silently
 * drops the rule, so `---` vanishes after saving. Mirrors the upstream
 * playground's HR transformer.
 */
export const hrTransformer: ElementTransformer = {
	dependencies: [HorizontalRuleNode],
	export: (node) => {
		if (!$isHorizontalRuleNode(node)) return null;
		return '---';
	},
	regExp: /^(---|\*\*\*|___)\s?$/,
	replace: (parentNode, _children, _match, isImport) => {
		void isImport;
		const hr = $createHorizontalRuleNode();
		parentNode.replace(hr);
		// Typing path with the rule at the end of the document: add an empty
		// paragraph to hold the cursor
		if (!isImport && !hr.getNextSibling()) {
			const paragraph = $createParagraphNode();
			hr.insertAfter(paragraph);
			paragraph.select();
		}
	},
	type: 'element'
};

// ── Image：`![alt](src)` ↔ ImageNode ──

/**
 * Image transformer (a standalone full-line image ↔ block-level ImageNode).
 *
 * Known limitations (deliberate):
 * - Only block-level standalone images (`![...](...)` alone on a line); an inline
 *   `![...](...)` inside a paragraph stays literal text (the render pipeline turns
 *   it into an <img>)
 * - alt text containing `]` or src containing `)` does not round-trip (rare, not escaped)
 */
export const imageTransformer: ElementTransformer = {
	dependencies: [ImageNode],
	export: (node) => {
		if (!$isImageNode(node)) return null;
		const tail = node.__tailAttrs ? ` {${node.__tailAttrs}}` : '';
		return `![${node.__alt}](${node.__src})${tail}`;
	},
	regExp: /^!\[([^\]]*)\]\(([^)\s]+)\)(?:\s+\{([^}]*)\})?$/,
	replace: (parentNode, _children, match, isImport) => {
		const alt = match[1] ?? '';
		const src = match[2] ?? '';
		const tail = (match[3] ?? '').trim();
		const decision = decideImage({ url: src, tailAttrs: tail || undefined });
		if (decision.kind === 'embed') {
			// spec 3.4: a provider or generic card instead of an image
			const embed = $createEmbedNode(src, alt, decision.provider, tail);
			parentNode.replace(embed);
			// no caret nudge: this transformer only ever runs on import (the same
			// pre-existing characteristic as the image path below)
			return;
		}
		const image = $createImageNode(src, alt, tail);
		parentNode.replace(image);
		// Typing path with the image at the end of the document: add an empty
		// paragraph to hold the cursor
		if (!isImport && !image.getNextSibling()) {
			const paragraph = $createParagraphNode();
			image.insertAfter(paragraph);
			paragraph.select();
		}
	},
	type: 'element'
};

// ── Table: GFM pipe table ↔ TableNode ──

/** A single pipe-table row (e.g. `| a | b |`) */
const TABLE_ROW_REGEX = /^\s*\|.*\|\s*$/;

/** Parse one pipe-table row into cell texts, handling `\|` escapes */
function parseTableRow(line: string): string[] {
	const content = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	const cells: string[] = [];
	let current = '';
	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (ch === '\\' && content[i + 1] === '|') {
			current += '|';
			i++;
		} else if (ch === '|') {
			cells.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	cells.push(current.trim());
	return cells;
}

/** Cell → single-line markdown (keeps inline formatting, folds newlines, escapes `|`) */
function tableCellToMarkdown(
	cell: TableCellNode,
	exportChildren: (node: TableCellNode) => string
): string {
	return exportChildren(cell).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Cell inline markdown → node spec tree (parsed by the temp editor).
 *
 * Table import takes the custom handleImportAfterStartMatch path and never goes
 * through the inline transformer pipeline; building plain text nodes from cell
 * text would leave bold / inline code / links literal. So the temp editor parses
 * the cell in full and the real editor rebuilds the nodes from the spec tree
 * (node instances cannot be transferred across editors).
 */
function inlineMarkdownToSpecs(markdown: string): SpecNode[] {
	const editor = getNestedTempEditor();
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			try {
				$convertFromMarkdownString(
					normalizeMarkdownForImport(markdown),
					NESTED_EDITOR_TRANSFORMERS
				);
				$unescapeImportedText();
			} catch {
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode(markdown));
				root.append(p);
			}
		},
		{ discrete: true }
	);
	return editor.getEditorState().read(() => {
		const first = $getRoot().getChildren()[0];
		if (!$isElementNode(first)) return [];
		return first.getChildren().map(specTreeFromNode);
	});
}

/**
 * GFM pipe table transformer.
 *
 * - Import: the 0.46 handleImportAfterStartMatch hook — starts at the header row
 *   and stops at the last consecutive `|` row; a `| --- |` divider row is required
 *   or the block falls back to plain text. Cell inline syntax (bold/italic/
 *   inline code/links) is parsed in full by the temp editor.
 * - Export: walk rows and columns into a pipe table, appending the divider after
 *   the first row; cells use exportChildren to keep inline formatting
 *   (bold/italic/inline code, …) and multiple paragraphs fold into one line.
 *
 * Known limitations: column alignment (`:---:`), rowspan/colspan merges take no
 * part in the markdown round-trip; the header state is not persisted either —
 * GFM pipe syntax needs a divider after the first row to be recognised, so export
 * always appends `| --- |` and import always treats the first row as the header;
 * TableCellMenu's "toggle header" reverts to a first-row header after
 * save/reload (the text itself is unaffected).
 */
export const tableTransformer: MultilineElementTransformer = {
	dependencies: [TableNode, TableRowNode, TableCellNode],
	regExpStart: TABLE_ROW_REGEX,
	regExpEnd: { regExp: /^(?!\s*\|)/, optional: true },
	handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
		// The second line must be the divider row, otherwise this is not a table
		// (return null, letting later transformers try)
		const dividerLine = (lines[startLineIndex + 1] ?? '').trim();
		if (!isTableRowDivider(dividerLine)) return null;

		// Collect the consecutive table rows (header and divider included)
		const rawRows: string[] = [lines[startLineIndex], lines[startLineIndex + 1]];
		let i = startLineIndex + 2;
		while (i < lines.length && TABLE_ROW_REGEX.test(lines[i])) {
			rawRows.push(lines[i]);
			i++;
		}

		const table = $createTableNode();
		rawRows.forEach((line, rowIndex) => {
			if (rowIndex === 1) return; // 分隔行不生成数据行
			const row = $createTableRowNode();
			for (const text of parseTableRow(line)) {
				const cell = $createTableCellNode(
					rowIndex === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS
				);
				const paragraph = $createParagraphNode();
				if (text) {
					// Inline markdown (bold/italic/inline code/links) parsed in full
					for (const spec of inlineMarkdownToSpecs(text)) {
						paragraph.append(nodeFromSpecTree(spec));
					}
				}
				cell.append(paragraph);
				row.append(cell);
			}
			table.append(row);
		});
		rootNode.append(table);
		// Return the index of the last consumed line
		return [true, i - 1];
	},
	replace: () => {
		// Import is handled by handleImportAfterStartMatch; typed shortcut input never converts tables
		return false;
	},
	export: (node, exportChildren) => {
		if (!$isTableNode(node)) return null;
		const rows = node.getChildren().filter($isTableRowNode);
		if (rows.length === 0) return null;
		const lines: string[] = [];
		rows.forEach((row, rowIndex) => {
			const cells = row.getChildren().filter($isTableCellNode);
			const line = `| ${cells.map((c) => tableCellToMarkdown(c, exportChildren)).join(' | ')} |`;
			lines.push(line);
			if (rowIndex === 0) {
				lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
			}
		});
		return lines.join('\n');
	},
	type: 'multiline-element'
};

// ── Alert: `> [!NOTE] title …` → AlertNode(spec §3.1)──

/** A line opening a blockquote alert; the marker itself is parsed in the handler. */
const ALERT_START_REGEX = /^>\s?\[!/;
/** A line that is not part of the blockquote ends the alert. */
const ALERT_END_REGEX = /^(?!>)/;
/** Prefix stripped from every body line before the nested editor parses it. */
const QUOTE_PREFIX_REGEX = /^>\s?/;

/**
 * Transformer subset used by nested editor content.
 *
 * Nested editors do not register TagNode/AlertNode (to prevent infinite nesting),
 * so markdown inside an alert is parsed with the standard transformers.
 * HR nodes are registered (see NESTED_EDITOR_NODES), so its transformer is
 * included to keep `---` round-tripping.
 */
/**
 * Counterpart of the core markdown export's safety escaping: the exporter
 * escapes markdown-significant punctuation (`a_b` -> `a\_b`) but the core's
 * plain-text import path never unescapes it, so repeated save/load cycles
 * re-escape the accumulated backslashes (no fixpoint). This mirrors the core's
 * own unescapeText rule (MarkdownImport text path) and skips code so literal
 * backslashes inside code spans/blocks stay intact.
 */
/**
 * The core's CHECK_LIST regex matches `[X]` case-insensitively
 * (CHECKLIST_REGEX has /i) but its checked-state comparison is
 * `match[3] === 'x'` — case-sensitive — so an uppercase box silently
 * imports as unchecked and the next export rewrites `- [X]` to
 * `- [ ]`. Lowercase the marker on list lines before importing.
 */
/** Internal step of {@link normalizeMarkdownForImport}; not exported. */
function normalizeChecklistMarkers(markdown: string): string {
	// No regex here on purpose: the core's CHECK_LIST shape needs a
	// whitespace class that is awkward to spell in a literal and easy to
	// mangle across tooling layers; plain string ops are exact.
	const lineBreak = String.fromCharCode(10);
	const upper = String.fromCharCode(91) + 'X' + String.fromCharCode(93);
	const lower = String.fromCharCode(91) + 'x' + String.fromCharCode(93);
	return markdown
		.split(lineBreak)
		.map((line) => {
			const trimmed = line.trimStart();
			const hasMarker =
				trimmed.startsWith('- ' + upper) ||
				trimmed.startsWith('* ' + upper) ||
				trimmed.startsWith('+ ' + upper);
			if (!hasMarker) return line;
			const at = line.indexOf(upper);
			if (at === -1) return line;
			return line.slice(0, at) + lower + line.slice(at + upper.length);
		})
		.join(lineBreak);
}

/**
 * Input normalization for every editor import boundary (main editor and the
 * nested temporary editors).
 *
 * CRLF content comes from the FormData transport (HTML entry-list rules
 * normalize field values). Line-anchored element transformers fail on the
 * trailing `\r` - the image rule's `$` anchor degraded an image to "!" +
 * link text on reopen (caught by the refs-lifecycle e2e) - so normalize to
 * LF here.
 *
 * A `\r` also used to double as the whitespace some bare marker lines need
 * (`- [ ]`, `[ ]`, `-`, `#`, `>` - core CHECK_LIST/QUOTE regExps want a
 * trailing space): those lines get one space before the CRs go, so the
 * pre-fix and post-fix parses agree for content stored through the form.
 * Two guards keep that pass honest (review round 2): lone CRs are promoted
 * to CRLF first (a lone `\r` hides its line end from the padding match),
 * and lines inside ``` / ~~~ fences are returned byte-identical (a fence
 * body line that happens to be a bare marker - diff fragments, `#` comment
 * lines in examples - must not be silently rewritten on open+save).
 */
export function normalizeMarkdownForImport(markdown: string): string {
	const withCrlfEnds = markdown.replace(/\r(?!\n)/g, '\r\n');
	let fence: { char: string; length: number } | null = null;
	const padded = withCrlfEnds
		.split('\n')
		.map((line) => {
			const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
			const opener = /^ {0,3}(`{3,}|~{3,})/.exec(bare);
			if (opener) {
				const marker = opener[1];
				if (!fence) {
					fence = { char: marker[0], length: marker.length };
				} else {
					const rest = bare.slice(opener[0].length).trim();
					if (marker[0] === fence.char && marker.length >= fence.length && rest === '') {
						fence = null;
					}
				}
				return line;
			}
			if (fence) return line;
			return line.replace(
				/^([ \t]*(?:[-*+][ \t]*\[[ xX]?\]|\[[ xX]?\]|[-*+]|\d+\.|#{1,6}|>))\r$/,
				'$1 \r'
			);
		})
		.join('\n');
	return normalizeChecklistMarkers(padded.replace(/\r\n?/g, '\n'));
}

export function $unescapeImportedText(): void {
	const unescape = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
	for (const node of $getRoot().getAllTextNodes()) {
		// Skip inline code (a text node with the 'code' format bit) and code
		// blocks/code-highlight children: backslash escapes are literal there
		// on the render side, so they must stay literal here too.
		if (node.hasFormat('code')) continue;
		const parent = node.getParent();
		if (parent && (parent.getType() === 'code' || parent.getType() === 'code-highlight')) continue;
		const text = node.getTextContent();
		// Fold control newlines that entered via numeric entities (`&#13;`):
		// the core decodes them AFTER the import boundary, and a CR left in a
		// text node splits the line on the next reopen - a non-fixed round
		// trip. HTML would fold these to spaces anyway.
		const next = unescape(text).replace(/[\r\n]/g, ' ');
		if (next !== text) node.setTextContent(next);
	}
}

export const NESTED_EDITOR_TRANSFORMERS: Transformer[] = [
	// Custom transformers must come before the core TRANSFORMERS (import tries them in
	// order and the earlier one wins): CHECK_LIST placed after ...TRANSFORMERS gets
	// consumed by UNORDERED_LIST first, which is the same as not fixing it;
	// mermaidTransformer has the same problem with the core CODE transformer, so a
	// ```mermaid block inside container content imports as a plain code block.
	CHECK_LIST,
	mermaidTransformer,
	...TRANSFORMERS,
	hrTransformer,
	spoilerTransformer,
	mentionTransformer,
	mathInlineTransformer,
	mathParenTransformer,
	mathBlockTransformer,
	footnoteRefTransformer,
	footnoteInlineTransformer,
	embedTransformer,
	detailsTransformer,
	tabsTransformer,
	gridTransformer
];

// Reused temporary nested editor (headless, no DOM).
// Creating one per export is too expensive, so the module caches a single
// instance (see design doc §8 upgrade note).
let nestedTempEditor: LexicalEditor | null = null;

function getNestedTempEditor(): LexicalEditor {
	if (!nestedTempEditor) {
		nestedTempEditor = createEditor({
			namespace: 'markdown-nested-temp',
			nodes: NESTED_EDITOR_NODES,
			theme: EDITOR_THEME,
			onError: (error: Error) => console.error('Nested temp editor error:', error)
		});
	}
	return nestedTempEditor;
}

/** Markdown → alert nested-editor editorState JSON (falls back to a plain-text
 * paragraph when parsing fails) */
/** Guards reentrancy: a container transformer runs this while the shared
 * temp editor is mid-update, which would swallow nested fences. */
let nestedTempDepth = 0;

export function markdownToAlertJson(markdown: string): string {
	const editor =
		nestedTempDepth > 0
			? createEditor({
					namespace: 'markdown-nested-oneoff',
					nodes: NESTED_EDITOR_NODES,
					theme: EDITOR_THEME,
					onError: (error: Error) => console.error('One-off nested editor error:', error)
				})
			: getNestedTempEditor();
	nestedTempDepth += 1;
	try {
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				try {
					$convertFromMarkdownString(
						normalizeMarkdownForImport(markdown),
						NESTED_EDITOR_TRANSFORMERS
					);
					$unescapeImportedText();
				} catch {
					root.clear();
					const p = $createParagraphNode();
					p.append($createTextNode(markdown));
					root.append(p);
				}
			},
			{ discrete: true }
		);
		return JSON.stringify(editor.getEditorState().toJSON());
	} finally {
		nestedTempDepth -= 1;
	}
}

/** Alert nested-editor editorState JSON → Markdown (empty string when the JSON is invalid) */
export function alertJsonToMarkdown(json: string): string {
	if (!json?.trim()) return '';
	const editor = getNestedTempEditor();
	try {
		const state = editor.parseEditorState(json);
		let markdown = '';
		state.read(() => {
			markdown = $convertToMarkdownString(NESTED_EDITOR_TRANSFORMERS);
		});
		return markdown;
	} catch {
		return '';
	}
}

/**
 * Alert transformer (multiline block, the blockquote carrier of spec §3.1).
 *
 * - Import uses handleImportAfterStartMatch: starts at the marker line and stops
 *   at the last consecutive `>` line; on stop the non-`>` line is **not
 *   consumed** and stays a separate block. Note the divergence from the renderer:
 *   CommonMark lazy continuation folds that line into the quote (as alert body)
 *   while the editor keeps it outside — neither side loses content, but the
 *   attribution differs.
 *   The body (with the `> ` prefix stripped) round-trips through nested editor
 *   JSON; the title lives in AlertNode.__title and returns to the marker line on
 *   export.
 * - Export: `> [!type] title` followed by `> `-prefixed lines.
 *
 * Known limitation: alerts do not nest (the nested editor does not register this
 * transformer), matching the editor's "no infinite nesting" rule.
 */
export const alertTransformer: MultilineElementTransformer = {
	dependencies: [AlertNode],
	regExpStart: ALERT_START_REGEX,
	regExpEnd: { regExp: ALERT_END_REGEX, optional: true },
	handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
		const parsed = parseAlertMarker((lines[startLineIndex] ?? '').replace(QUOTE_PREFIX_REGEX, ''));
		if (!parsed) return null; // unknown marker → the core quote transformer takes it
		const { type } = parsed;
		const title = parsed.rest.trim();
		const bodyLines: string[] = [];
		let i = startLineIndex + 1;
		while (i < lines.length && lines[i].startsWith('>')) {
			bodyLines.push(lines[i].replace(QUOTE_PREFIX_REGEX, ''));
			i++;
		}
		rootNode.append(
			$createAlertNode(type, markdownToAlertJson(bodyLines.join('\n').trim()), title)
		);
		// Return the last consumed line; the terminating line stays in the document.
		return [true, i - 1];
	},
	replace: () => {
		// Import is handled by handleImportAfterStartMatch; typing shortcuts do not
		// create alerts (multi-line blocks need an explicit insert).
		return false;
	},
	export: (node) => {
		if (!$isAlertNode(node)) return null;
		const header = `> [!${node.__alertType.toUpperCase()}]${node.__title ? ` ${node.__title}` : ''}`;
		const inner = alertJsonToMarkdown(node.__jsonContent);
		if (!inner) return header;
		const body = inner
			.split('\n')
			.map((line) => (line ? `> ${line}` : '>'))
			.join('\n');
		return `${header}\n${body}`;
	},
	type: 'multiline-element'
};

// ── Spec-tree transfer helpers (shared by the spec-based transformers) ──

/**
 * Intermediate representation for moving nodes across editors (plain JSON data).
 * Node instances cannot be reused across editors and cannot be created in a read
 * context, so the temp editor only collects a (class, json) spec tree and the real
 * nodes are rebuilt from it inside the target editor's update context.
 */
interface SpecNode {
	klass: typeof LexicalNode;
	json: SerializedLexicalNode;
	children: SpecNode[];
}

function specTreeFromNode(node: LexicalNode): SpecNode {
	return {
		klass: node.constructor as typeof LexicalNode,
		json: node.exportJSON(),
		children: $isElementNode(node) ? node.getChildren().map(specTreeFromNode) : []
	};
}

function nodeFromSpecTree(spec: SpecNode): LexicalNode {
	const clone = spec.klass.importJSON(spec.json);
	if ($isElementNode(clone) && spec.children.length > 0) {
		clone.append(...spec.children.map(nodeFromSpecTree));
	}
	return clone;
}

// ── Sup/Sub: `<sup>x</sup>` / `<sub>x</sub>` ↔ superscript/subscript format ──

/**
 * Superscript/subscript transformer (inline-HTML syntax round-trip).
 *
 * Markdown has no native sup/sub syntax (`~x~` collides with GFM strikethrough),
 * so this uses inline HTML: the render pipeline's remarkRehype
 * (allowDangerousHtml) + rehype-raw already support it, and rehype-sanitize
 * allows sup/sub by default (verified on both the server and client pipelines).
 */
export const superscriptTransformer: TextMatchTransformer = {
	dependencies: [],
	importRegExp: /<sup>(.+?)<\/sup>/,
	regExp: /<sup>(.+?)<\/sup>$/,
	replace: (textNode, match) => {
		// importFoundTextMatchTransformer has already split the textNode at the exact match
		textNode.setTextContent(match[1] ?? '');
		textNode.setFormat('superscript');
	},
	export: (node, _exportChildren, exportFormat) => {
		if (!$isTextNode(node) || !node.hasFormat('superscript')) return null;
		// exportFormat keeps the node's other inline formats (e.g. <sup>**x**</sup>)
		return `<sup>${exportFormat(node, node.getTextContent())}</sup>`;
	},
	trigger: '>',
	type: 'text-match'
};

export const subscriptTransformer: TextMatchTransformer = {
	dependencies: [],
	importRegExp: /<sub>(.+?)<\/sub>/,
	regExp: /<sub>(.+?)<\/sub>$/,
	replace: (textNode, match) => {
		textNode.setTextContent(match[1] ?? '');
		textNode.setFormat('subscript');
	},
	export: (node, _exportChildren, exportFormat) => {
		if (!$isTextNode(node) || !node.hasFormat('subscript')) return null;
		return `<sub>${exportFormat(node, node.getTextContent())}</sub>`;
	},
	trigger: '>',
	type: 'text-match'
};

// ── Mark: `==x==` ↔ highlight format (spec §2 #5) ──
// No custom transformer needed: the core TRANSFORMERS in @lexical/markdown 0.46
// already ship the HIGHLIGHT text format (`==` ↔ highlight) — import, export and
// flanking included; the render side uses remark-mark (micromark attention).

// ── Aggregation ──

/**
 * Full editor transformer list: core syntax + Tag + Alert + HR + Image + Table
 * + Sup/Sub。
 *
 * Ordering rule: custom transformers first (multiline import tries them one by one
 * and text-match export tries them in order, earlier wins), core TRANSFORMERS after.
 */
export const EDITOR_TRANSFORMERS: Transformer[] = [
	tagTransformer,
	spoilerTransformer,
	mentionTransformer,
	alertTransformer,
	hrTransformer,
	imageTransformer,
	tableTransformer,
	superscriptTransformer,
	subscriptTransformer,
	mathInlineTransformer,
	mathParenTransformer,
	mathBlockTransformer,
	footnoteRefTransformer,
	footnoteInlineTransformer,
	embedTransformer,
	mermaidTransformer,
	detailsTransformer,
	tabsTransformer,
	gridTransformer,
	// 0.46's core exports CHECK_LIST but leaves it out of TRANSFORMERS — without it
	// `- [ ] x` is consumed by UNORDERED_LIST first and the checkbox degrades to the
	// literal text `[ ]`. It must be tried before UNORDERED_LIST, hence ahead of
	// ...TRANSFORMERS.
	CHECK_LIST,
	...TRANSFORMERS
];
