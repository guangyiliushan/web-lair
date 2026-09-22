/**
 * Toolbar → LinkHoverEditor channel (batch 3b).
 *
 * The link buttons live in EditorToolbar / FloatingFormatToolbar; the hover
 * editor is mounted once per MarkdownEditor. A window CustomEvent keeps the
 * two decoupled without module state (no dispose dance, works across the
 * portal-mounted toolbars).
 */
export const OPEN_LINK_EDITOR_EVENT = 'md:open-link-editor';

export function openLinkEditor(): void {
	window.dispatchEvent(new CustomEvent(OPEN_LINK_EDITOR_EVENT));
}
