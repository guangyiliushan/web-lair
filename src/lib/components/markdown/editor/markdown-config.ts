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
import { remarkSpoiler } from '$lib/components/markdown/plugins/remark-spoiler';
import { remarkMark } from '$lib/components/markdown/plugins/remark-mark';
import { remarkMathGuard } from '$lib/components/markdown/plugins/remark-math-guard';
import { remarkMention } from '$lib/components/markdown/plugins/remark-mention';
import { remarkTag } from '$lib/components/markdown/plugins/remark-tag';
import { attentionHandlers } from '$lib/components/markdown/plugins/attention-marker';

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
 * 构建 rehype-sanitize schema。
 *
 * 在 defaultSchema 基础上扩展：
 * - KaTeX 输出的 MathML 标签和属性
 * - Shiki 高亮输出的 data-* 属性
 * - 自定义组件（spoiler/mermaid/mention/tag/callout）的 class
 * - 图片 loading 属性
 *
 * 注意：hast-util-sanitize v5 使用 hast **属性名**（如 className），
 * 而非 HTML 属性名（class）；'data*' 为特殊值，放行全部 data-* 属性。
 *
 * 该 schema 同时用于服务端管线和客户端轻量管线。
 */
export function buildSanitizeSchema(): Schema {
	return {
		...defaultSchema,
		attributes: {
			...defaultSchema.attributes,
			// 允许所有元素携带 class/style/id 与 data-*（KaTeX/Shiki/自定义组件依赖）
			'*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'style', 'id', 'data*'],
			// hast-util-sanitize 的 findDefinition 只取第一个同名条目:
			// defaultSchema 对 a 的受限条目 ['className','data-footnote-backref']
			// 匹配失败时返回空数组并短路 '*' 兜底,必须先移除再追加裸 className。
			a: [
				...(defaultSchema.attributes?.a ?? []).filter(
					(entry) => !(Array.isArray(entry) && entry[0] === 'className')
				),
				'target',
				'rel',
				'className'
			],
			img: [...(defaultSchema.attributes?.img ?? []), 'loading', 'className', 'width', 'height'],
			code: [...(defaultSchema.attributes?.code ?? []), 'className'],
			pre: [...(defaultSchema.attributes?.pre ?? []), 'className'],
			span: [...(defaultSchema.attributes?.span ?? []), 'className', 'style', 'ariaHidden'],
			div: [...(defaultSchema.attributes?.div ?? []), 'className', 'style'],
			figure: [...(defaultSchema.attributes?.figure ?? []), 'className'],
			figcaption: [...(defaultSchema.attributes?.figcaption ?? []), 'className'],
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
			// §4.5 原始 HTML 白名单中 defaultSchema 未收录的元素
			'mark',
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
			src: ['http', 'https', 'data'],
			href: ['http', 'https', 'mailto']
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
		.use(remarkTag)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS overload 限制
		.use(remarkRehype as any, { allowDangerousHtml: true, handlers: attentionHandlers })
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rehype-katex Options vs boolean overload
		.use(rehypeKatex as any, { throwOnError: false })
		.use(rehypeRaw)
		.use(rehypeSanitize, buildSanitizeSchema())
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
