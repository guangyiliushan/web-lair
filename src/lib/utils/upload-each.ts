import { applyAction, deserialize } from '$app/forms';
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
 *
 * Protocol note: SvelteKit serializes action data with devalue, so the JSON
 * body's `data` field is a STRING. `response.json()` would hand us a string and
 * silently lose every result — the client half of the protocol is
 * `deserialize()` (the same function `use:enhance` uses internally).
 *
 * Rate accounting: the admin upload bucket counts one unit per request
 * (60/10min per user), so ten files spend ten units. The CLI import
 * (`pnpm media:import`) stays the bulk path; the form is for small batches.
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
	/** Per-file cap from the page's `limits` (25MB today). */
	maxBytes: number;
	fallbackMessage: string;
	/** Optional size-specific message (the page has the translated limit copy). */
	tooLargeMessage?: (name: string) => string;
}): Promise<{ results: UploadOutcome[]; message?: string; redirected?: boolean }> {
	const results: UploadOutcome[] = [];
	let message: string | undefined;

	for (const file of options.files) {
		if (file.size > options.maxBytes) {
			// Skip the doomed request: adapter-node rejects an oversized body
			// with a 413 (SvelteKitError) before the action runs.
			results.push({
				fileName: file.name,
				ok: false,
				code: 'too-large',
				message: options.tooLargeMessage?.(file.name) ?? options.fallbackMessage
			});
			continue;
		}

		const body = new FormData();
		body.append('files', file);
		try {
			const response = await fetch(options.action, {
				method: 'POST',
				body,
				headers: { accept: 'application/json', 'x-sveltekit-action': 'true' },
				// A request that never settles must not wedge the disabled button.
				// The floor is ~50 KB/s so a 25 MB file on a slow uplink still fits.
				signal: AbortSignal.timeout(Math.max(120_000, Math.ceil(file.size / 50_000) * 1000))
			});
			const result = deserialize(await response.text());

			if (result.type === 'redirect') {
				// Session expired mid-batch: navigate and stop sending the remaining
				// files unauthenticated. A failing navigation must still be terminal.
				try {
					await applyAction(result);
				} catch (error) {
					console.warn('[upload] redirect navigation failed', error);
					// The batch is over and the page is still here: say why.
					message = options.fallbackMessage;
				}
				return { results, message, redirected: true };
			}

			if (result.type === 'success' || result.type === 'failure') {
				const data = (result.data ?? {}) as UploadActionData;
				if (data.uploadResults) {
					results.push(...data.uploadResults);
				} else {
					results.push({
						fileName: file.name,
						ok: false,
						message: data.message ?? options.fallbackMessage
					});
				}
				if (data.message) message = data.message;
			} else if (result.type === 'error') {
				results.push({
					fileName: file.name,
					ok: false,
					message: result.error?.message ?? options.fallbackMessage
				});
			} else {
				// A JSON body without an ActionResult type (CSRF 403 JSON, proxy error):
				// never drop the file from the report.
				const body = result as unknown as { message?: string };
				results.push({
					fileName: file.name,
					ok: false,
					message: body.message ?? options.fallbackMessage
				});
			}
		} catch (error) {
			// Non-JSON body (413/500), a redirect to HTML, or a network failure.
			message = options.fallbackMessage;
			results.push({ fileName: file.name, ok: false, message: options.fallbackMessage });
			console.warn('[upload] request failed', file.name, error);
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
	const data: UploadActionData = {};
	if (outcome.results.length > 0) data.uploadResults = outcome.results;
	if (outcome.message) data.message = outcome.message;
	await applyAction({
		type: anyOk ? 'success' : 'failure',
		status: anyOk ? 200 : 400,
		data
	} as ActionResult);
	await invalidateAll();
}
