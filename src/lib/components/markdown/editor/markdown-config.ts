import { unified, type Processor } from 'unified';
import type { Root as MdastRoot } from 'mdast';
import type { Root as HastRoot } from 'hast';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { remarkContainerDirective } from '$lib/components/markdown/plugins/remark-directive';
import { remarkImageAttr } from '$lib/components/markdown/plugins/remark-image-attr';
import { remarkCodeMeta } from '$lib/components/markdown/plugins/remark-code-meta';
import { remarkImageEmbed } from '$lib/components/markdown/plugins/remark-image-embed';
import { rehypeCodeMeta } from '$lib/components/markdown/plugins/rehype-code-meta';
import { rehypeMermaid } from '$lib/components/markdown/plugins/rehype-mermaid';
import { rehypeCodeLines } from '$lib/components/markdown/plugins/rehype-code-lines';
import { rehypeHeadingAnchors } from '$lib/components/markdown/plugins/rehype-heading-anchors';
import { remarkSpoiler } from '$lib/components/markdown/plugins/remark-spoiler';
import { remarkMark } from '$lib/components/markdown/plugins/remark-mark';
import { remarkMathGuard } from '$lib/components/markdown/plugins/remark-math-guard';
import { remarkMathParen } from '$lib/components/markdown/plugins/remark-math-paren';
import { remarkMention } from '$lib/components/markdown/plugins/remark-mention';
import { remarkAlert } from '$lib/components/markdown/plugins/remark-alert';
import { attentionHandlers } from '$lib/components/markdown/plugins/attention-marker';
import {
	rehypeMarkPipelineNodes,
	rehypeRawHtmlWhitelist
} from '$lib/components/markdown/plugins/rehype-raw-html-whitelist';

import type { Schema } from 'hast-util-sanitize';

// ── Types ──

/** Markdown feature flags, enabled on demand */
export interface MarkdownFeatureFlags {
	/** KaTeX math (block + inline), defaults to true */
	math?: boolean;
	/** GitHub Flavored Markdown tables/task lists/strikethrough, defaults to true */
	gfm?: boolean;
	/** Shiki highlighting for fenced code blocks (server-side only); defaults to false
	 * (the client preview does not highlight) */
	codeHighlight?: boolean;
	/** Allow raw HTML tags through (defaults to false — extremely dangerous) */
	allowHtml?: boolean;
}

/** Render options */
export interface MarkdownRenderOptions {
	/** Feature flags */
	features?: MarkdownFeatureFlags;
	/** Link target */
	linkTarget?: '_blank' | '_self';
	/** Whether to sanitize the rendered HTML, defaults to true */
	sanitize?: boolean;
}

/** Props type of MarkdownEditor.svelte */
export interface MarkdownEditorProps {
	/**
	 * Initial markdown. The editor reads it only once on mount; to swap content, change
	 * `key` or round-trip through code mode (a `value` prop holding Lexical JSON also
	 * existed historically — declared but never wired up, now removed).
	 */
	initialMarkdown?: string;
	/** Whether the editor is editable, defaults to true */
	editable?: boolean;
	placeholder?: string;
	theme?: 'default' | 'compact';
	autofocus?: boolean;
	showToolbar?: boolean; // 默认 true
	class?: string;
}

/** Payload of the editor change event */
export interface MarkdownEditorChangeDetail {
	/** Lexical JSON string (the page layer stores it in the content column) */
	editorStateJson: string;
	/** Projected markdown text (the page layer stores it in the text column) */
	markdown: string;
	/** Plain text (for summaries/search) */
	plainText: string;
	/** Whether the editor is empty */
	isEmpty: boolean;
}

/** Props type of MarkdownRenderer.svelte */
export interface MarkdownRendererProps {
	/** Markdown source (rendered synchronously on the client) */
	source?: string;
	/** Pre-rendered HTML (preferred in SSR, skips client rendering) */
	html?: string;
	features?: MarkdownFeatureFlags;
	class?: string;
	prose?: boolean;
	/** Whether to sanitize the incoming html again, defaults to true (set false when the
	 * server already sanitized it) */
	sanitize?: boolean;
	/** Empty-state snippet */
	children?: import('svelte').Snippet;
}

// ── rehype-sanitize schema ──

/**
 * Builds the rehype-sanitize schema (spec 4.5, tightened).
 *
 * On top of defaultSchema:
 * - the global attribute surface is className/id only (class is pipeline
 *   output, never user input); style and data-* are narrowed to per-element
 *   allowlists
 * - style is kept for: span (KaTeX output) and code (Shiki output)
 * - data-* allowlist (derived from auditing the real pipeline output): Shiki
 *   (data-rehype-pretty-code-figure/-language/-theme/-line) and GFM
 *   footnotes (data-footnote-ref/-notes/-backref)
 * - the 4.5 whitelist elements carry their closed attribute key sets
 *   (kbd/mark/tag/details/video/audio/...)
 * - protocols: href allows the mention token schemes (@gh/@tw/@tg); src
 *   drops data: (the `!` syntax is the only image entry point)
 *
 * hast-util-sanitize's findDefinition takes only the first entry with a
 * given name, so the restricted tuple in defaultSchema must be removed before
 * appending a bare className (see the a element).
 *
 * The same schema serves both the server and the client light pipeline.
 */
export function buildSanitizeSchema(): Schema {
	// hast-util-sanitize's findDefinition takes the FIRST entry with a matching
	// name, so a restricted `className` tuple inherited from defaultSchema
	// (a: ['className','data-footnote-backref'], code: [['className', {}]],
	// section: ['className','footnotes']) shadows any bare `className` appended
	// later. Drop those tuples before appending the permissive entry.
	const withoutClassNameTuple = (entry: unknown): boolean =>
		!(Array.isArray(entry) && entry[0] === 'className');
	return {
		...defaultSchema,
		attributes: {
			...defaultSchema.attributes,
			'*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'id'],
			a: [
				...(defaultSchema.attributes?.a ?? []).filter(withoutClassNameTuple),
				'target',
				'rel',
				'className',
				// 3.4 embed placeholder cards (pipeline output only)
				'dataEmbed',
				'dataUrl'
			],
			img: [...(defaultSchema.attributes?.img ?? []), 'loading', 'className', 'width', 'height'],
			code: [
				...(defaultSchema.attributes?.code ?? []).filter(withoutClassNameTuple),
				'className',
				'dataLanguage',
				'dataTheme',
				'style',
				'translate'
			],
			pre: [
				...(defaultSchema.attributes?.pre ?? []),
				'className',
				'dataRehypePrettyCodeFigure',
				'translate'
			],
			figure: [
				...(defaultSchema.attributes?.figure ?? []),
				'className',
				'dataRehypePrettyCodeFigure',
				'dataLanguage',
				'dataTheme'
			],
			figcaption: [
				...(defaultSchema.attributes?.figcaption ?? []),
				'className',
				'dataRehypePrettyCodeCaption'
			],
			span: [
				...(defaultSchema.attributes?.span ?? []),
				'className',
				'style',
				'dataLine',
				'ariaHidden',
				// spoiler tooltip text (pipeline output, produced by the attention handler)
				'title'
			],
			div: [
				...(defaultSchema.attributes?.div ?? []),
				'className',
				// 3.2 container parameters (pipeline output only; raw content cannot
				// forge them — the provenance pass strips raw attributes)
				'dataCols',
				'dataRows',
				'dataGap',
				'dataLayout',
				'dataType',
				'dataLabel'
			],
			sup: [...(defaultSchema.attributes?.sup ?? []), 'dataFootnoteRef'],
			section: [
				...(defaultSchema.attributes?.section ?? []).filter(withoutClassNameTuple),
				'dataFootnotes',
				'className'
			],
			// 4.5 whitelist element attribute key sets
			details: ['open', 'id', 'className', 'dataMdCollapse'],
			abbr: ['title'],
			time: ['datetime'],
			source: ['src', 'type'],
			// video/audio carry no className: raw-side class is stripped before
			// sanitize (spec 4.5 list) and the pipeline emits none — keep this list
			// identical to RAW_ATTRS in rehype-raw-html-whitelist.ts
			video: ['src', 'poster', 'width', 'height', 'muted', 'loop', 'preload'],
			audio: ['src', 'width', 'height', 'muted', 'loop', 'preload'],
			// Attributes of the MathML tags KaTeX emits
			math: ['xmlns', 'display'],
			annotation: ['encoding'],
			mspace: ['width'],
			mstyle: ['mathcolor', 'mathbackground', 'displaystyle', 'scriptlevel'],
			menclose: ['notation']
		},
		tagNames: [
			...(defaultSchema.tagNames ?? []),
			'figure',
			'figcaption',
			// 4.5 raw-HTML whitelist elements missing from defaultSchema
			'mark',
			'abbr',
			'tag',
			'audio',
			'video',
			'time',
			// KaTeX MathML tags (rehype-katex output: 'htmlAndMathml' emits these)
			'math',
			'semantics',
			'annotation',
			'mrow',
			'mi',
			'mo',
			'mn',
			'ms',
			'mtext',
			'mfrac',
			'msqrt',
			'mroot',
			'msub',
			'msup',
			'msubsup',
			'mover',
			'munder',
			'munderover',
			'mtable',
			'mtr',
			'mtd',
			'mspace',
			'mstyle',
			'menclose',
			'mpadded',
			'mphantom'
		],
		protocols: {
			...defaultSchema.protocols,
			src: ['http', 'https'],
			// poster is an image context on video/audio: keep it http(s)-only too,
			// otherwise `data:`/`javascript:` would flow back in after src was closed
			poster: ['http', 'https'],
			// 3.5: mention token schemes must be explicitly allowed, otherwise the sanitizer drops href="@gh:x"
			href: ['http', 'https', 'mailto', '@gh', '@tw', '@tg']
		}
	};
}

// ── Lightweight synchronous rendering (for the client preview) ──

/** Exact type of the pipeline Processor — kept in sync with src/lib/server/markdown.ts */
type MarkdownProcessor = Processor<MdastRoot, MdastRoot, HastRoot, HastRoot, string>;

/**
 * Client-side lightweight processor singleton.
 *
 * It leaves out rehype-pretty-code (Shiki), which needs async initialisation and does
 * not fit the synchronous preview. rehype-mermaid is included (at the same position as
 * on the server, before pretty-code): without mermaid.js loaded its mount point shows
 * the raw code text, so the two pipelines agree on the DOM.
 *
 * rehype-katex and every remark plugin are synchronous, so processSync() is usable.
 */
let lightProcessor: MarkdownProcessor | null = null;

function getLightProcessor(): MarkdownProcessor {
	if (lightProcessor) return lightProcessor;
	const p = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkMath)
		.use(remarkMathParen)
		.use(remarkMathGuard)
		.use(remarkDirective)
		.use(remarkContainerDirective)
		.use(remarkSpoiler)
		.use(remarkMark)
		.use(remarkMention)
		.use(remarkAlert)
		.use(remarkImageAttr)
		.use(remarkCodeMeta)
		.use(remarkImageEmbed)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS overload limitations
		.use(remarkRehype as any, { allowDangerousHtml: true, handlers: attentionHandlers })
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rehype-katex Options vs boolean overload
		.use(rehypeKatex as any, { throwOnError: false })
		.use(rehypeCodeMeta)
		.use(rehypeMermaid)
		.use(rehypeCodeLines)
		.use(rehypeMarkPipelineNodes)
		.use(rehypeRaw)
		.use(rehypeRawHtmlWhitelist)
		.use(rehypeSanitize, buildSanitizeSchema())
		// ids and anchors are generated after the sanitizer: it clobbers id
		// attributes and cannot tell pipeline ids from raw ones (spec 3.6)
		.use(rehypeHeadingAnchors)
		.use(rehypeStringify);
	lightProcessor = p;
	return p;
}

/**
 * Client-side synchronous rendering (no Shiki highlighting; Mermaid only emits the
 * mount point, executed client-side in MarkdownRenderer).
 *
 * Used by:
 * - MarkdownRenderer's client rendering mode (no html prop passed)
 *
 * @param markdown raw Markdown string
 * @returns sanitized, safe HTML string
 */
export function renderMarkdownToHtmlSync(markdown: string): string {
	if (!markdown?.trim()) return '';
	const processor = getLightProcessor();
	return String(processor.processSync(markdown));
}

/** Clear the processor cache (mainly for tests) */
export function clearRendererCache(): void {
	lightProcessor = null;
}
