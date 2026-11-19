import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-file upload client: the SvelteKit action JSON protocol, not plain JSON.
 * `response.json()` would yield a devalue string and lose every result.
 */
const { applyActionMock, deserializeMock, invalidateAllMock, fetchMock } = vi.hoisted(() => ({
	applyActionMock: vi.fn(async () => {}),
	deserializeMock: vi.fn(),
	invalidateAllMock: vi.fn(async () => {}),
	fetchMock: vi.fn()
}));

vi.mock('$app/forms', () => ({ applyAction: applyActionMock, deserialize: deserializeMock }));
vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }));

import { applyUploadResults, mapUploadError, uploadEachFile } from './upload-each';

function file(name: string, size = 4): File {
	return new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
}

beforeEach(() => {
	applyActionMock.mockReset();
	deserializeMock.mockReset();
	invalidateAllMock.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockResolvedValue({ text: async () => 'serialized' });
});

describe('uploadEachFile', () => {
	it('merges per-file results and sends the documented headers', async () => {
		deserializeMock.mockReturnValue({
			type: 'success',
			status: 200,
			data: { uploadResults: [{ fileName: 'a.jpg', ok: true }] }
		});

		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback'
		});

		expect(outcome.results).toEqual([{ fileName: 'a.jpg', ok: true }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const init = fetchMock.mock.calls[0]![1] as RequestInit;
		expect(init.headers).toMatchObject({
			accept: 'application/json',
			'x-sveltekit-action': 'true'
		});
		// The action reads getAll('files'); a renamed field would 400 every file.
		const body = init.body as FormData;
		expect(body.getAll('files')).toHaveLength(1);
		// Without a signal a hung request keeps `uploading` true forever.
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect((body.get('files') as File).name).toBe('a.jpg');
	});

	it('maps a framework error status instead of showing its English text', async () => {
		fetchMock.mockResolvedValueOnce({ status: 413, text: async () => 'Payload Too Large' });
		deserializeMock.mockReturnValue({ type: 'error', error: { message: 'Payload Too Large' } });

		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			mapError: (status, name) => (status === 413 ? `too big: ${name}` : undefined)
		});

		expect(outcome.results[0]).toMatchObject({ ok: false, message: 'too big: a.jpg' });
		expect(outcome.results[0]?.message).not.toContain('Payload');
	});

	it('falls back to translated copy for an unmapped 500', async () => {
		fetchMock.mockResolvedValueOnce({ status: 500, text: async () => '{}' });
		deserializeMock.mockReturnValue({ type: 'error', error: { message: 'Internal server error' } });

		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			mapError: () => undefined
		});

		expect(outcome.results[0]).toMatchObject({ ok: false, message: 'fallback' });
		expect(outcome.results[0]?.message).not.toContain('Internal');
	});

	it('maps a status on a JSON body that is not an ActionResult', async () => {
		fetchMock.mockResolvedValueOnce({ status: 403, text: async () => '{}' });
		deserializeMock.mockReturnValue({ message: 'Cross-site POST form submissions are forbidden' });

		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			mapError: (status) => (status === 403 ? 'session expired' : undefined)
		});

		expect(outcome.results[0]).toMatchObject({ ok: false, message: 'session expired' });
	});

	it('maps a status when the body is not JSON at all', async () => {
		fetchMock.mockResolvedValueOnce({ status: 413, text: async () => 'Payload Too Large' });
		deserializeMock.mockImplementation(() => {
			throw new Error('not JSON');
		});

		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			mapError: (status, name) => (status === 413 ? `too big: ${name}` : undefined)
		});

		expect(outcome.results[0]).toMatchObject({
			fileName: 'a.jpg',
			ok: false,
			message: 'too big: a.jpg'
		});
	});

	it('stops at a redirect (session expired) and applies it', async () => {
		deserializeMock.mockReturnValue({ type: 'redirect', status: 303, location: '/login' });

		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg'), file('b.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback'
		});

		expect(outcome.redirected).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(applyActionMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'redirect', location: '/login' })
		);
	});

	it('surfaces a friendly message when the response is not the action protocol', async () => {
		deserializeMock.mockImplementation(() => {
			throw new SyntaxError('invalid JSON');
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback'
		});

		expect(outcome.message).toBe('fallback');
		expect(outcome.results).toEqual([
			expect.objectContaining({ fileName: 'a.jpg', ok: false, message: 'fallback' })
		]);
		warn.mockRestore();
	});

	it('skips an oversized file and reports the size limit, not a generic failure', async () => {
		deserializeMock.mockReturnValue({
			type: 'success',
			status: 200,
			data: { uploadResults: [{ fileName: 'ok.jpg', ok: true }] }
		});
		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('big.jpg', 50), file('ok.jpg', 4)],
			maxBytes: 10,
			fallbackMessage: 'fallback',
			tooLargeMessage: (name) => `too big: ${name}`
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(outcome.results[0]).toMatchObject({
			fileName: 'big.jpg',
			ok: false,
			code: 'too-large',
			message: 'too big: big.jpg'
		});
		expect(outcome.results[1]).toMatchObject({ fileName: 'ok.jpg', ok: true });
	});

	it('keeps a row for a JSON body that is not an ActionResult', async () => {
		deserializeMock.mockReturnValue({ message: 'cross-site post rejected' });
		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback'
		});
		// The body's English text is ignored: without a status map the page's
		// translated fallback is the only copy that may reach the UI.
		expect(outcome.results).toEqual([
			expect.objectContaining({ fileName: 'a.jpg', ok: false, message: 'fallback' })
		]);
	});

	it('stops after a redirect even when the navigation itself fails', async () => {
		deserializeMock.mockReturnValue({ type: 'redirect', status: 303, location: '/login' });
		applyActionMock.mockRejectedValueOnce(new Error('navigation failed'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg'), file('b.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback'
		});
		expect(outcome.redirected).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('reports every file through onProgress, including the ones it never sends', async () => {
		deserializeMock.mockReturnValue({
			type: 'success',
			status: 200,
			data: { uploadResults: [{ fileName: 'ok.jpg', ok: true }] }
		});
		const seen: Array<[number, string]> = [];

		await uploadEachFile({
			action: '?/upload',
			// big.jpg is rejected before the request; a.jpg fails at the server.
			files: [file('big.jpg', 50), file('ok.jpg', 4)],
			maxBytes: 10,
			fallbackMessage: 'fallback',
			onProgress: (index, state) => seen.push([index, state])
		});

		expect(seen).toEqual([
			[0, 'error'],
			[1, 'uploading'],
			[1, 'done']
		]);
	});

	it('marks the queue chip as failed when a request reports a partial result', async () => {
		// One request, two rows (photos: file row + gallery row) — one row failing
		// must not leave the chip in the `done` state.
		deserializeMock.mockReturnValue({
			type: 'success',
			status: 200,
			data: {
				uploadResults: [
					{ fileName: 'a.jpg', ok: true, added: true },
					{ fileName: 'a.jpg', ok: false, message: 'gallery insert failed' }
				]
			}
		});
		const seen: string[] = [];

		await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			onProgress: (_index, state) => seen.push(state)
		});

		expect(seen).toEqual(['uploading', 'error']);
	});

	it('reports an error state when the session redirect ends the batch', async () => {
		deserializeMock.mockReturnValue({ type: 'redirect', status: 303, location: '/login' });
		const seen: string[] = [];

		await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			onProgress: (_index, state) => seen.push(state)
		});

		expect(seen).toEqual(['uploading', 'error']);
	});

	// The queue must never be left on `uploading` when a batch ends early.

	it('reports cancelled (not error) for the rest of the batch on a session redirect', async () => {
		deserializeMock.mockReturnValue({ type: 'redirect', status: 303, location: '/login' });
		const seen: [number, string][] = [];

		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg'), file('b.jpg'), file('c.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			onProgress: (index, state) => seen.push([index, state])
		});

		expect(outcome.redirected).toBe(true);
		// a.jpg failed on the redirect; b/c were never sent and must not sit
		// on `uploading` once the caller re-renders after the jump.
		expect(seen).toEqual([
			[0, 'uploading'],
			[0, 'error'],
			[1, 'cancelled'],
			[2, 'cancelled']
		]);
	});

	it('cancels the in-flight request and stops the batch when the signal aborts', async () => {
		fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
			const signal = init?.signal as AbortSignal;
			return new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
			});
		});
		const seen: [number, string][] = [];
		const controller = new AbortController();

		const pending = uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg'), file('b.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			signal: controller.signal,
			onProgress: (index, state) => seen.push([index, state])
		});
		controller.abort();

		const outcome = await pending;
		expect(outcome.cancelled).toBe(true);
		// Only the first request was ever made; the second file is not sent.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(seen).toEqual([
			[0, 'uploading'],
			[0, 'cancelled'],
			[1, 'cancelled']
		]);
		// A cancel is not a file failure: nothing is blamed on the user's pick.
		expect(outcome.results).toEqual([]);
	});

	it('sends nothing and reports the whole batch cancelled when already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const seen: [number, string][] = [];

		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg'), file('b.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			signal: controller.signal,
			onProgress: (index, state) => seen.push([index, state])
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(outcome.cancelled).toBe(true);
		expect(seen).toEqual([
			[0, 'cancelled'],
			[1, 'cancelled']
		]);
	});

	it('merges the caller signal with the per-request timeout instead of replacing it', async () => {
		deserializeMock.mockReturnValue({
			type: 'success',
			status: 200,
			data: { uploadResults: [{ fileName: 'a.jpg', ok: true }] }
		});
		const controller = new AbortController();

		await uploadEachFile({
			action: '?/upload',
			files: [file('a.jpg')],
			maxBytes: 100,
			fallbackMessage: 'fallback',
			signal: controller.signal
		});

		const init = fetchMock.mock.calls[0]![1] as RequestInit;
		const signal = init.signal as AbortSignal;
		expect(signal.aborted).toBe(false);
		// The merged signal must still carry the caller's abort.
		controller.abort();
		expect(signal.aborted).toBe(true);
	});
});

describe('applyUploadResults', () => {
	it('omits an empty result list and always invalidates', async () => {
		await applyUploadResults({ results: [], message: 'too many' });
		expect(applyActionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'failure',
				status: 400,
				data: { message: 'too many' }
			})
		);
		expect(invalidateAllMock).toHaveBeenCalledTimes(1);
	});
});

describe('mapUploadError', () => {
	const copy = {
		tooBig: (name: string) => `too big: ${name}`,
		rate: () => 'rate',
		session: () => 'session'
	};

	it('maps the three framework statuses', () => {
		expect(mapUploadError(413, 'a.jpg', copy)).toBe('too big: a.jpg');
		expect(mapUploadError(429, 'a.jpg', copy)).toBe('rate');
		expect(mapUploadError(403, 'a.jpg', copy)).toBe('session');
	});

	it('leaves every other status to the page fallback', () => {
		expect(mapUploadError(400, 'a.jpg', copy)).toBeUndefined();
		expect(mapUploadError(500, 'a.jpg', copy)).toBeUndefined();
	});
});
