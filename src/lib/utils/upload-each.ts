import { applyAction } from '$app/forms';
import { invalidateAll } from '$app/navigation';
import type { ActionResult } from '@sveltejs/kit';

/**
 * Per-file upload submission (deploy batch D-1, Q4 ruling).
 *
 * The admin upload actions keep their batch contract — one file per request is
 * a legal batch of one. The browser sends each selected file in its own
 * request, so a 10 x 25MB selection never becomes a single 250MB body under
 * adapter-node's BODY_SIZE_LIMIT (26M). Results are merged and applied once so
 * the pages keep rendering `form.uploadResults` exactly as before.
 */
export interface UploadOutcome {
	fileName: string;
	ok: boolean;
	code?: string;
	message?: string;
	[key: string]: unknown;
}

interface UploadActionData {
	uploadResults?: UploadOutcome[];
	message?: string;
}

export async function uploadEachFile(options: {
	/** Route-relative action URL, e.g. `?/upload`. */
	action: string;
	files: File[];
	fallbackMessage: string;
}): Promise<{ results: UploadOutcome[]; message?: string }> {
	const results: UploadOutcome[] = [];
	let message: string | undefined;

	for (const file of options.files) {
		const body = new FormData();
		body.append('files', file);
		try {
			const response = await fetch(options.action, {
				method: 'POST',
				body,
				// SvelteKit's programmatic form-action protocol: JSON in, JSON out.
				headers: { 'x-sveltekit-action': 'true' }
			});
			const result = (await response.json()) as ActionResult;
			if (result.type === 'success' || result.type === 'failure') {
				const data = (result.data ?? {}) as UploadActionData;
				if (data.uploadResults) results.push(...data.uploadResults);
				if (data.message) message = data.message;
			} else if (result.type === 'error') {
				message = result.error?.message ?? options.fallbackMessage;
			}
		} catch (error) {
			message = error instanceof Error ? error.message : options.fallbackMessage;
		}
	}

	if (results.length === 0 && !message) message = options.fallbackMessage;
	return { results, message };
}

/** Applies the merged result so the page's `form` prop updates in place. */
export async function applyUploadResults(outcome: {
	results: UploadOutcome[];
	message?: string;
}): Promise<void> {
	const anyOk = outcome.results.some((result) => result.ok);
	const data: UploadActionData = { uploadResults: outcome.results };
	if (outcome.message) data.message = outcome.message;
	await applyAction({
		type: anyOk ? 'success' : 'failure',
		status: anyOk ? 200 : 400,
		data
	} as ActionResult);
	await invalidateAll();
}
