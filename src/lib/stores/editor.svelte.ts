// Editor store — manages draft state, dirty detection, auto-save.
import { writable } from 'svelte/store';

// Use svelte stores for compatibility; migrate to $state() when ready
export const editorDraft = writable<{
	title: string;
	content: string;
	savedAt: number | null;
}>({ title: '', content: '', savedAt: null });

export const editorDirty = writable(false);
