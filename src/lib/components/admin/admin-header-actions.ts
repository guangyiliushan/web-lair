import { getContext, setContext } from 'svelte';

export type AdminHeaderActionHandler = () => void;

const KEY = Symbol('admin-header-action-registry');

/**
 * `load` functions can only describe header actions (label/icon/href) — a
 * click handler cannot cross the server/client boundary. The layout provides
 * this registry so a page can bind its declared `actionId` to page-local
 * behaviour such as opening a dialog.
 */
export class AdminHeaderActionRegistry {
	private handlers = new Map<string, AdminHeaderActionHandler>();

	register(id: string, handler: AdminHeaderActionHandler): () => void {
		this.handlers.set(id, handler);
		return () => {
			if (this.handlers.get(id) === handler) this.handlers.delete(id);
		};
	}

	run(id: string): void {
		this.handlers.get(id)?.();
	}
}

/** Layout-side: create the registry shared by the header and the active page. */
export function createAdminHeaderActionRegistry(): AdminHeaderActionRegistry {
	const registry = new AdminHeaderActionRegistry();
	setContext(KEY, registry);
	return registry;
}

/** Page-side: the registry provided by the admin layout, if any. */
export function useAdminHeaderActionRegistry(): AdminHeaderActionRegistry | undefined {
	return getContext<AdminHeaderActionRegistry | undefined>(KEY);
}
