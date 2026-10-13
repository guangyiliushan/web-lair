import { COMMAND_PRIORITY_EDITOR, type LexicalEditor } from 'lexical';
import { DRAG_DROP_PASTE } from '@lexical/rich-text';
import {
	EditorUploadError,
	altFromName,
	tailAttrsOf,
	uploadEditorImage
} from '$lib/media/editor-uploads';
import { insertImage } from '$lib/components/markdown/editor/lexical-helpers';

/** Paste/drop upload status surfaced to the editor chrome. */
export interface EditorUploadStatus {
	/** Files still uploading in the current burst. */
	uploading: number;
	/** Failure code of the most recent failed file (cleared on the next burst). */
	lastErrorCode: string | null;
}

/** Q3 cap: at most three uploads in flight. */
const MAX_CONCURRENT_UPLOADS = 3;

/**
 * Paste/drop image uploads (ST-3 3a3): @lexical/rich-text already routes
 * pasted and dropped local files into the DRAG_DROP_PASTE command (drop
 * caret placement included), so this plugin only has to consume the File[]
 * payload: local files only, at most three uploads in flight, each result
 * inserted as it lands. Failed files are never consumed beyond the event -
 * nothing is inserted for them and the user can simply paste again.
 */
export function registerEditorUploads(
	editor: LexicalEditor,
	onStatus: (status: EditorUploadStatus) => void
): () => void {
	let disposed = false;
	let uploading = 0;
	let lastErrorCode: string | null = null;

	function startUploads(files: File[]) {
		lastErrorCode = null;
		uploading += files.length;
		onStatus({ uploading, lastErrorCode });
		let next = 0;
		const run = async () => {
			while (next < files.length) {
				const file = files[next++];
				try {
					const result = await uploadEditorImage(file);
					if (disposed) break;
					insertImage(editor, result.url, altFromName(file.name), tailAttrsOf(result));
				} catch (error) {
					if (disposed) break;
					lastErrorCode = error instanceof EditorUploadError ? error.code : 'network';
				} finally {
					uploading = Math.max(0, uploading - 1);
					if (!disposed) onStatus({ uploading, lastErrorCode });
				}
			}
		};
		const runners = Math.min(MAX_CONCURRENT_UPLOADS, files.length);
		void Promise.all(Array.from({ length: runners }, () => run()));
	}

	const unregister = editor.registerCommand(
		DRAG_DROP_PASTE,
		(files) => {
			// Local images only; anything else falls through to the default
			// paste/drop behaviour (Q3: HTML-only pastes keep the text path).
			const images = files.filter((file) => file.type === '' || file.type.startsWith('image/'));
			if (images.length === 0) return false;
			startUploads(images);
			return true;
		},
		COMMAND_PRIORITY_EDITOR
	);

	return () => {
		disposed = true;
		unregister();
	};
}
