/**
 * Unified exports of the Markdown component module.
 *
 * @module markdown
 * @description Markdown component layer built on a Unified (remark/rehype) render
 * pipeline plus a Lexical editor.
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

// Server-side rendering (only available in a server context)
// Note: do not re-export src/lib/server/markdown.ts here; callers import
// '$lib/server/markdown' directly to keep the server-only boundary.
