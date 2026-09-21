/**
 * Batch D: shared mount bookkeeping for decorator nodes.
 *
 * Lexical DEV deep-freezes nodes after each reconciliation, so a Svelte
 * component handle must never live on the node instance (writing it once
 * more throws `Cannot assign to read only property` and aborts the
 * reconcile, e.g. on undo). Keep the handles in a WeakMap instead.
 */
import type { LexicalNode } from 'lexical';
import { mount, unmount } from 'svelte';

type MountedDecoratorHandle = Record<string, unknown>;

const handles = new WeakMap<LexicalNode, MountedDecoratorHandle>();

/** Unmounts a previously mounted decorator component for this node, if any. */
export function unmountDecorator(node: LexicalNode): void {
	const handle = handles.get(node);
	if (!handle) return;
	try {
		unmount(handle);
	} catch {
		// ignore stale unmounts
	}
	handles.delete(node);
}

/** Mounts a decorator component for this node and remembers the handle.
 * `fallbackText` is shown when the component cannot be mounted, so a broken
 * decorator stays visible and removable instead of becoming an empty box. */
export function mountDecorator(
	node: LexicalNode,
	component: unknown,
	target: HTMLElement,
	props: Record<string, unknown>,
	fallbackText?: string
): void {
	unmountDecorator(node);
	try {
		handles.set(
			node,
			mount(component as never, { target, props, intro: false }) as MountedDecoratorHandle
		);
	} catch (error) {
		console.error('Decorator mount failed:', error);
		if (fallbackText) {
			target.textContent = fallbackText;
			target.classList.add('rich-editor-decorator-error');
		}
	}
}
