import { createContext } from 'svelte';
import type { LexicalEditor, EditorThemeClasses } from 'lexical';

export interface EditorRuntimeContext {
	/** Main editor instance (ready lazily) */
	editor: LexicalEditor | null;
	/** Theme configuration reference */
	theme: EditorThemeClasses;
	/** Error callback */
	onError: (error: Error) => void;
}

const [getEditorContext, setEditorContext] = createContext<EditorRuntimeContext>();

export { getEditorContext, setEditorContext };
