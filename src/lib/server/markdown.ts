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
import { remarkMathParen } from '$lib/components/markdown/plugins/remark-math-paren';
import { remarkMention } from '$lib/components/markdown/plugins/remark-mention';
import { remarkAlert } from '$lib/components/markdown/plugins/remark-alert';
import { attentionHandlers } from '$lib/components/markdown/plugins/attention-marker';
import {
	rehypeMarkPipelineNodes,
	rehypeRawHtmlWhitelist
} from '$lib/components/markdown/plugins/rehype-raw-html-whitelist';
import { rehypeMermaid } from '$lib/components/markdown/plugins/rehype-mermaid';
import { rehypeCodeLines } from '$lib/components/markdown/plugins/rehype-code-lines';
import { rehypeTranslateNo } from '$lib/components/markdown/plugins/rehype-translate-no';
// Import the schema from its module of origin: the barrel re-exports the
// whole editor graph (Lexical, mermaid, KaTeX components), which turned every
// server-side test that touches the pipeline into a multi-minute transform.
import { buildSanitizeSchema } from '$lib/components/markdown/editor/markdown-config';

/**
 * Exact type of the pipeline Processor.
 *
 * Type inference through the unified() chain:
 *   remarkParse:      string → MdastRoot (mdast syntax tree)
 *   remarkRehype:     MdastRoot (mdast) → HastRoot (hast HTML tree)
 *   rehypeStringify:  HastRoot → string (HTML)
 *
 * Processor<ParserInput, ParserOutput, CompilerInput, CompilerOutput, Result>
 */
type MarkdownProcessor = Processor<MdastRoot, MdastRoot, HastRoot, HastRoot, string>;

/**
 * The processor singleton.
 *
 * Shiki's first initialisation loads grammar files (~100-200ms); later calls reuse the
 * same processor. Promise wrapper: the unified().use() chain is synchronous but
 * rehype-pretty-code initialises the Shiki highlighter asynchronously inside, so the
 * once pattern guarantees a single initialisation.
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
			// \(…\) / \[…\]: the unambiguous equivalents (spec 2 #2)
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
			.use(rehypeKatex as any, {
				throwOnError: false,
				output: 'htmlAndMathml'
			})
			// code info-string rendering runs before rehype-pretty-code so the
			// transport attribute never has to survive that pass (3.3)
			.use(rehypeCodeMeta)
			// the mermaid pass must see the pristine pre > code.language-mermaid
			// node: rehype-pretty-code rebuilds the block and drops the language
			// class, so it is registered before pretty-code (both pipelines
			// register it at this position, spec 3.3)
			.use(rehypeMermaid)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rehype-pretty-code Options type compatibility
			.use(rehypePrettyCode as any, {
				theme: {
					dark: 'github-dark-default',
					light: 'github-light-default'
				},
				keepBackground: false
			})
			// line structure + numbering + collapsed previews (spec 3.3) — after
			// pretty-code, which owns the server line spans
			.use(rehypeCodeLines)
			.use(rehypeTranslateNo)
			.use(rehypeMarkPipelineNodes)
			.use(rehypeRaw)
			.use(rehypeRawHtmlWhitelist)
			.use(rehypeSanitize, buildSanitizeSchema())
			// ids and anchors are generated after the sanitizer: it clobbers id
			// attributes and cannot tell pipeline ids from raw ones (spec 3.6)
			.use(rehypeHeadingAnchors)
			.use(rehypeStringify);

		// rehype-pretty-code initialises Shiki asynchronously on the first run
		await processor.process('');
		processorCache = processor;
		return processor;
	})();

	try {
		return await processorInitPromise;
	} catch (error) {
		// A transient initialisation failure (Shiki/plugin/fs) must not poison
		// the singleton: keep the rejection observable for this call, but let
		// the next request retry instead of 500-ing until a restart.
		processorInitPromise = null;
		throw error;
	}
}

/**
 * Server-side rendering: Markdown → safe HTML (with KaTeX + Shiki highlighting).
 *
 * Callable only in a server context (+page.server.ts / +server.ts).
 * SvelteKit's $lib/server path convention keeps this module out of the client bundle.
 *
 * @returns sanitized, safe HTML string
 */
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
	if (!markdown?.trim()) return '';
	const processor = await getProcessor();
	const result = await processor.process(markdown);
	return String(result);
}

/**
 * Tree-mode rendering for the segment-comment marking pass. The caller needs
 * the transformed hast tree — block directory first, then
 * `span.wl-cm` marks — and only then the HTML.
 *
 * Why not a plugin: a frozen unified processor rejects `.use()` ("Cannot call
 * `use` on a frozen processor"), and rebuilding the whole
 * chain per request would re-initialise Shiki. `run()` + `stringify()` on THIS
 * instance stay on the same compiler, so `stringifyMarkdownTree(renderMarkdownTree(md))`
 * is byte-identical to `renderMarkdownToHtml(md)` when no mark is applied — the
 * equivalence test pins that.
 */
export async function renderMarkdownTree(markdown: string): Promise<HastRoot> {
	if (!markdown?.trim()) return { type: 'root', children: [] };
	const processor = await getProcessor();
	return (await processor.run(processor.parse(markdown))) as HastRoot;
}

/** Serialize a (possibly marked) tree with the singleton processor's compiler. */
export async function stringifyMarkdownTree(tree: HastRoot): Promise<string> {
	const processor = await getProcessor();
	return processor.stringify(tree);
}

/** Clear the processor cache (mainly for tests and hot reload) */
export function clearServerProcessorCache(): void {
	processorCache = null;
	processorInitPromise = null;
}
