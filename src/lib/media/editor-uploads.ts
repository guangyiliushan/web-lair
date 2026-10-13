/**
 * Shared contract for the admin editor image uploads (ST-3 3a): the endpoint
 * path, the picker payload shape and the one-file upload call are consumed by
 * the insert dialog, the paste/drop plugin and the route tests - single
 * source instead of mirrored copies (review round 2, Q16).
 */

/** Same-origin admin endpoint (single-file multipart POST / picker GET). */
export const EDITOR_UPLOADS_ENDPOINT = '/admin/editor-uploads';

/** Picker list item as served by `GET ?source=photos|files`. */
export interface PickerItem {
	id: string;
	name: string;
	url: string;
	previewUrl: string;
	width: number | null;
	height: number | null;
}

/** POST response (Q10: one result per uploaded file). */
export interface EditorUploadResult {
	id: string;
	objectKey: string;
	url: string;
	fullUrl: string;
	width: number | null;
	height: number | null;
	mimeType: string;
	byteSize: number;
	deduplicated: boolean;
}

/** Thrown by `uploadEditorImage`; `code` mirrors the endpoint's {code} set. */
export class EditorUploadError extends Error {
	constructor(public code: string) {
		super(code);
		this.name = 'EditorUploadError';
	}
}

/** "cover.png" -> "cover". Markdown-bracket metacharacters and newlines are
 *  stripped so a file name cannot inject extra image/link structure into the
 *  emitted markdown (the renderer sanitizes HTML, not markdown structure). */
export function altFromName(name: string): string {
	return name
		.replace(/\.[a-z0-9]{1,10}$/i, '')
		.replace(/[\\[\]()\n\r]/g, '')
		.slice(0, 128);
}

/** Inner `{width=W height=H}` text when both dimensions are known (Q11). */
export function tailAttrsOf(dims: { width?: number | null; height?: number | null }): string {
	return dims.width != null && dims.height != null
		? `width=${dims.width} height=${dims.height}`
		: '';
}

/** One-file upload (the endpoint takes a single `file` field per request).
 *  The client must send `Accept: application/json` (Q2/Q10): it is what turns
 *  a CSRF rejection into the {code} envelope instead of a plain-text 403. */
export async function uploadEditorImage(file: File): Promise<EditorUploadResult> {
	const form = new FormData();
	form.set('file', file);
	let response: Response;
	try {
		response = await fetch(EDITOR_UPLOADS_ENDPOINT, {
			method: 'POST',
			headers: { accept: 'application/json' },
			body: form
		});
	} catch {
		throw new EditorUploadError('network');
	}
	const body = (await response.json().catch(() => null)) as
		(Partial<EditorUploadResult> & { code?: string }) | null;
	if (!response.ok || !body?.url) {
		throw new EditorUploadError(body?.code ?? `HTTP ${response.status}`);
	}
	return body as EditorUploadResult;
}
