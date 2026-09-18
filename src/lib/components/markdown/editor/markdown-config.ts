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
import { rehypeHeadingAnchors } from '$lib/components/markdown/plugins/rehype-heading-anchors';
import { remarkSpoiler } from '$lib/components/markdown/plugins/remark-spoiler';
import { remarkMark } from '$lib/components/markdown/plugins/remark-mark';
import { remarkMathGuard } from '$lib/components/markdown/plugins/remark-math-guard';
import { remarkMention } from '$lib/components/markdown/plugins/remark-mention';
import { remarkAlert } from '$lib/components/markdown/plugins/remark-alert';
import { attentionHandlers } from '$lib/components/markdown/plugins/attention-marker';
import {
	rehypeMarkPipelineNodes,
	rehypeRawHtmlWhitelist
} from '$lib/components/markdown/plugins/rehype-raw-html-whitelist';

import type { Schema } from 'hast-util-sanitize';

// ── 类型定义 ──

/** 按需启用的 Markdown 特性开关 */
export interface MarkdownFeatureFlags {
	/** KaTeX 数学公式（块级 + 行内），默认 true */
	math?: boolean;
	/** GitHub Flavored Markdown 表格/任务列表/删除线，默认 true */
	gfm?: boolean;
	/** 围栏代码块 Shiki 高亮（仅服务端可用），默认 false（客户端预览不高亮） */
	codeHighlight?: boolean;
	/** 是否允许原始 HTML 标签通过（默认 false，极度危险） */
	allowHtml?: boolean;
}

/** 渲染选项 */
export interface MarkdownRenderOptions {
	/** 特性开关 */
	features?: MarkdownFeatureFlags;
	/** 链接 target */
	linkTarget?: '_blank' | '_self';
	/** 渲染后是否做 HTML sanitize，默认 true */
	sanitize?: boolean;
}

/** MarkdownEditor.svelte props 类型 */
export interface MarkdownEditorProps {
	/** Lexical JSON 字符串（优先于 initialMarkdown） */
	value?: string | null;
	/** 初始 markdown（当无 value 时使用） */
	initialMarkdown?: string;
	/** 是否可编辑，默认 true */
	editable?: boolean;
	placeholder?: string;
	theme?: 'default' | 'compact';
	autofocus?: boolean;
	showToolbar?: boolean; // 默认 true
	class?: string;
}

/** 编辑器变更事件载荷 */
export interface MarkdownEditorChangeDetail {
	/** Lexical JSON 字符串（页面层存入 content 字段） */
	editorStateJson: string;
	/** 投影的 markdown 文本（页面层存入 text 字段） */
	markdown: string;
	/** 纯文本（用于摘要/搜索） */
	plainText: string;
	/** 编辑器是否为空 */
	isEmpty: boolean;
}

/** MarkdownRenderer.svelte props 类型 */
export interface MarkdownRendererProps {
	/** markdown 源码（客户端同步渲染） */
	source?: string;
	/** 预渲染 HTML（SSR 场景优先使用，跳过客户端渲染） */
	html?: string;
	features?: MarkdownFeatureFlags;
	class?: string;
	prose?: boolean;
	/** 是否对传入的 html 做二次清洗，默认 true（若 html 已由服务端清洗可设 false） */
	sanitize?: boolean;
	/** 空态插槽 */
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
				'className'
			],
			img: [...(defaultSchema.attributes?.img ?? []), 'loading', 'className', 'width', 'height'],
			code: [
				...(defaultSchema.attributes?.code ?? []).filter(withoutClassNameTuple),
				'className',
				'dataLanguage',
				'dataTheme',
				'style'
			],
			pre: [...(defaultSchema.attributes?.pre ?? []), 'className', 'dataRehypePrettyCodeFigure'],
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
				'ariaHidden'
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
			details: ['open', 'id', 'className'],
			abbr: ['title'],
			time: ['datetime'],
			source: ['src', 'type'],
			// video/audio carry no className: raw-side class is stripped before
			// sanitize (spec 4.5 list) and the pipeline emits none — keep this list
			// identical to RAW_ATTRS in rehype-raw-html-whitelist.ts
			video: ['src', 'poster', 'width', 'height', 'muted', 'loop', 'preload'],
			audio: ['src', 'width', 'height', 'muted', 'loop', 'preload'],
			// KaTeX 输出的 MathML 标签属性
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
			// KaTeX MathML 标签（rehype-katex output: 'htmlAndMathml' 会输出这些）
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

// ── 轻量同步渲染（客户端预览用）──

/** 管线 Processor 的精确类型 — 与 src/lib/server/markdown.ts 保持一致 */
type MarkdownProcessor = Processor<MdastRoot, MdastRoot, HastRoot, HastRoot, string>;

/**
 * 客户端轻量 processor 单例。
 *
 * 不包含 rehype-pretty-code（Shiki）和 rehype-mermaid：
 * - Shiki 需要异步初始化，不适合同步预览场景
 * - Mermaid 需要客户端脚本，预览中显示原始代码即可
 *
 * rehype-katex 和所有 remark 插件都是同步的，processSync() 可用。
 */
let lightProcessor: MarkdownProcessor | null = null;

function getLightProcessor(): MarkdownProcessor {
	if (lightProcessor) return lightProcessor;
	const p = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkMath)
		.use(remarkMathGuard)
		.use(remarkDirective)
		.use(remarkContainerDirective)
		.use(remarkSpoiler)
		.use(remarkMark)
		.use(remarkMention)
		.use(remarkAlert)
		.use(remarkImageAttr)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS overload 限制
		.use(remarkRehype as any, { allowDangerousHtml: true, handlers: attentionHandlers })
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rehype-katex Options vs boolean overload
		.use(rehypeKatex as any, { throwOnError: false })
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
 * 客户端同步渲染（无 Shiki 代码高亮、无 Mermaid 渲染）。
 *
 * 用于：
 * - MarkdownRenderer 的客户端渲染模式（当未传入 html prop 时）
 *
 * @param markdown 原始 Markdown 字符串
 * @returns 已清洗的安全 HTML 字符串
 */
export function renderMarkdownToHtmlSync(markdown: string): string {
	if (!markdown?.trim()) return '';
	const processor = getLightProcessor();
	return String(processor.processSync(markdown));
}

/** 清除 processor 缓存（主要用于测试场景） */
export function clearRendererCache(): void {
	lightProcessor = null;
}
