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

/** Per-file lifecycle reported to the caller's queue UI. Index is into `files`. */
export type UploadProgressState = 'uploading' | 'done' | 'error' | 'cancelled';

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
	/** Maps a framework/proxy HTTP status to a translated message. */
	mapError?: (status: number, fileName: string) => string | undefined;
	/** Drives the caller's per-file queue chip; optional so queue-less callers stay simple. */
	onProgress?: (index: number, state: UploadProgressState) => void;
	/**
	 * Caller-owned cancel switch (F-1). Aborting it cancels the in-flight
	 * request AND stops the batch: the remaining files are reported `cancelled`
	 * and never sent. Merged with the per-request timeout below, so a hung
	 * request still settles on its own.
	 */
	signal?: AbortSignal;
}): Promise<{
	results: UploadOutcome[];
	message?: string;
	redirected?: boolean;
	/** True when `signal` aborted the batch (not a timeout, not a redirect). */
	cancelled?: boolean;
}> {
	const results: UploadOutcome[] = [];
	let message: string | undefined;
	const progress = options.onProgress ?? (() => {});

	/** Everything from `from` on never ran: close the queue UI out as cancelled. */
	const cancelRest = (from: number) => {
		for (let rest = from; rest < options.files.length; rest++) progress(rest, 'cancelled');
	};

	for (let index = 0; index < options.files.length; index++) {
		// Cancelled while the previous file was in flight: don't start this one.
		if (options.signal?.aborted) {
			cancelRest(index);
			return { results, message, cancelled: true };
		}
		const file = options.files[index]!;
		if (file.size > options.maxBytes) {
			// Skip the doomed request: adapter-node rejects an oversized body
			// with a 413 (SvelteKitError) before the action runs.
			results.push({
				fileName: file.name,
				ok: false,
				code: 'too-large',
				message: options.tooLargeMessage?.(file.name) ?? options.fallbackMessage
			});
			progress(index, 'error');
			continue;
		}

		const body = new FormData();
		body.append('files', file);
		let status = 0;
		progress(index, 'uploading');
		try {
			// A request that never settles must not wedge the disabled button.
			// The floor is ~50 KB/s so a 25 MB file on a slow uplink still fits.
			const timeout = AbortSignal.timeout(Math.max(120_000, Math.ceil(file.size / 50_000) * 1000));
			const response = await fetch(options.action, {
				method: 'POST',
				body,
				headers: { accept: 'application/json', 'x-sveltekit-action': 'true' },
				signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
			});
			status = response.status;
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
				progress(index, 'error');
				// The rest were never sent: without this they stay `uploading`
				// forever once the caller's queue re-renders after the jump.
				cancelRest(index + 1);
				return { results, message, redirected: true };
			}

			if (result.type === 'success' || result.type === 'failure') {
				const data = (result.data ?? {}) as UploadActionData;
				if (data.uploadResults) {
					results.push(...data.uploadResults);
					// The action can report several rows per request (photos: file row
					// plus gallery row); only all-rows-ok leaves the chip in `done`.
					progress(index, data.uploadResults.every((row) => row.ok) ? 'done' : 'error');
				} else {
					results.push({
						fileName: file.name,
						ok: false,
						message: data.message ?? options.fallbackMessage
					});
					progress(index, 'error');
				}
				if (data.message) message = data.message;
			} else if (result.type === 'error') {
				// Framework errors are English and rarely actionable; map the status
				// to the page's copy instead of showing the raw message.
				results.push({
					fileName: file.name,
					ok: false,
					// Never surface a framework message (English) to the localized UI;
					// unmapped statuses fall back to the page's translated copy.
					message: options.mapError?.(status, file.name) ?? options.fallbackMessage
				});
				progress(index, 'error');
			} else {
				// A JSON body without an ActionResult type (CSRF 403 JSON, proxy error):
				// never drop the file from the report.
				results.push({
					fileName: file.name,
					ok: false,
					message: options.mapError?.(status, file.name) ?? options.fallbackMessage
				});
				progress(index, 'error');
			}
		} catch (error) {
			// The caller's cancel switch is not a file failure: the chip must say
			// "cancelled", and the batch is over rather than merely one file short.
			if (options.signal?.aborted) {
				progress(index, 'cancelled');
				cancelRest(index + 1);
				return { results, message, cancelled: true };
			}
			// Non-JSON body (413/500), a redirect to HTML, a timeout, or network loss.
			message = options.fallbackMessage;
			results.push({
				fileName: file.name,
				ok: false,
				message: options.mapError?.(status, file.name) ?? options.fallbackMessage
			});
			progress(index, 'error');
			console.warn('[upload] request failed', file.name, error);
		}
	}

	if (results.length === 0 && !message) message = options.fallbackMessage;
	return { results, message };
}

/**
 * Shared status mapping for the two admin uploaders (keeps the copy and the
 * branch set in one place so a page cannot silently drop a status).
 */
export function mapUploadError(
	status: number,
	fileName: string,
	copy: { tooBig: (name: string) => string; rate: () => string; session: () => string }
): string | undefined {
	switch (status) {
		case 413:
			return copy.tooBig(fileName);
		case 429:
			return copy.rate();
		case 403:
			return copy.session();
		default:
			return undefined;
	}
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
