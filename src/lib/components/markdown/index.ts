/**
 * Markdown 组件模块统一导出。
 *
 * @module markdown
 * @description 基于 Unified (remark/rehype) 渲染管线 + Lexical 编辑器的 Markdown 组件层。
 */

export { MarkdownEditor, MarkdownRenderer } from '$lib/components/markdown/editor';
export {
	EditorToolbar,
	FloatingFormatToolbar,
	BlockHandleToolbar,
	EditorDebugDialog
} from '$lib/components/markdown/toolbar';

export {
	renderMarkdownToHtmlSync,
	clearRendererCache,
	buildSanitizeSchema
} from '$lib/components/markdown/editor/markdown-config';

export type {
	MarkdownFeatureFlags,
	MarkdownRenderOptions,
	MarkdownEditorProps,
	MarkdownEditorChangeDetail,
	MarkdownRendererProps
} from '$lib/components/markdown/editor/markdown-config';

export {
	$createAlertNode,
	$isAlertNode,
	insertAlert
} from '$lib/components/markdown/editor/lexical-helpers';
export type { AlertType } from '$lib/components/markdown/alert/alert-types';
export type { SerializedAlertNode } from '$lib/components/markdown/alert/alert-node';

// 服务端渲染（仅在 server context 可用）
// 注：不要在这里 re-export src/lib/server/markdown.ts，
// 由调用方直接 import '$lib/server/markdown' 以确保 server-only 边界。
