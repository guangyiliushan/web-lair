import { unified, type Processor } from 'unified';
import type { Root as MdastRoot } from 'mdast';
import type { Root as HastRoot } from 'hast';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import rehypePrettyCode from 'rehype-pretty-code';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { remarkContainerDirective } from '$lib/components/markdown/plugins/remark-directive';
import { remarkImageAttr } from '$lib/components/markdown/plugins/remark-image-attr';
import { remarkCodeMeta } from '$lib/components/markdown/plugins/remark-code-meta';
import { remarkImageEmbed } from '$lib/components/markdown/plugins/remark-image-embed';
import { rehypeCodeMeta } from '$lib/components/markdown/plugins/rehype-code-meta';
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
import { rehypeMermaid } from '$lib/components/markdown/plugins/rehype-mermaid';
import { buildSanitizeSchema } from '$lib/components/markdown';

/**
 * 管线 Processor 的精确类型。
 *
 * unified() 链的类型推断：
 *   remarkParse:      string → MdastRoot (mdast 语法树)
 *   remarkRehype:     MdastRoot (mdast) → HastRoot (hast HTML 树)
 *   rehypeStringify:  HastRoot → string (HTML)
 *
 * Processor<ParserInput, ParserOutput, CompilerInput, CompilerOutput, Result>
 */
type MarkdownProcessor = Processor<MdastRoot, MdastRoot, HastRoot, HastRoot, string>;

/**
 * Processor 单例。
 *
 * Shiki 首次初始化需加载语法文件（~100-200ms），后续调用复用同一 processor。
 * Promise 包装：unified().use() 链是同步的，但 rehype-pretty-code 内部
 * 会异步初始化 Shiki highlighter。使用 once 模式确保只初始化一次。
 */
let processorCache: MarkdownProcessor | null = null;
let processorInitPromise: Promise<MarkdownProcessor> | null = null;

async function getProcessor(): Promise<MarkdownProcessor> {
	if (processorCache) return processorCache;
	if (processorInitPromise) return processorInitPromise;

	processorInitPromise = (async () => {
		const processor = unified()
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
			.use(remarkCodeMeta)
			.use(remarkImageEmbed)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS overload 限制
			.use(remarkRehype as any, { allowDangerousHtml: true, handlers: attentionHandlers })
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rehype-katex Options vs boolean overload
			.use(rehypeKatex as any, {
				throwOnError: false,
				output: 'htmlAndMathml'
			})
			// code info-string rendering runs before rehype-pretty-code so the
			// transport attribute never has to survive that pass (3.3)
			.use(rehypeCodeMeta)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rehype-pretty-code Options 类型兼容
			.use(rehypePrettyCode as any, {
				theme: {
					dark: 'github-dark-default',
					light: 'github-light-default'
				},
				keepBackground: false
			})
			.use(rehypeMermaid)
			.use(rehypeMarkPipelineNodes)
			.use(rehypeRaw)
			.use(rehypeRawHtmlWhitelist)
			.use(rehypeSanitize, buildSanitizeSchema())
			// ids and anchors are generated after the sanitizer: it clobbers id
			// attributes and cannot tell pipeline ids from raw ones (spec 3.6)
			.use(rehypeHeadingAnchors)
			.use(rehypeStringify);

		// rehype-pretty-code 在首次 run 时异步初始化 Shiki
		await processor.process('');
		processorCache = processor;
		return processor;
	})();

	return processorInitPromise;
}

/**
 * 服务端渲染：Markdown → 安全 HTML（含 KaTeX + Shiki 高亮）。
 *
 * 仅可在 server context 调用（+page.server.ts / +server.ts）。
 * SvelteKit 通过 $lib/server 路径约定确保此模块不会被打包到客户端。
 *
 * @param markdown 原始 Markdown 字符串
 * @returns 已清洗的安全 HTML 字符串
 */
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
	if (!markdown?.trim()) return '';
	const processor = await getProcessor();
	const result = await processor.process(markdown);
	return String(result);
}

/** 清除 processor 缓存（主要用于测试和热重载场景） */
export function clearServerProcessorCache(): void {
	processorCache = null;
	processorInitPromise = null;
}
