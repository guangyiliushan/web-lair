import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-file upload client (D-1 Q4): the SvelteKit action JSON protocol, not
 * plain JSON. `response.json()` would yield a devalue string and lose every
 * result — the P0 this test exists to prevent.
 */
const { applyActionMock, deserializeMock, invalidateAllMock, fetchMock } = vi.hoisted(() => ({
	applyActionMock: vi.fn(async () => {}),
	deserializeMock: vi.fn(),
	invalidateAllMock: vi.fn(async () => {}),
	fetchMock: vi.fn()
}));

vi.mock('$app/forms', () => ({ applyAction: applyActionMock, deserialize: deserializeMock }));
vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }));

import { applyUploadResults, uploadEachFile } from './upload-each';

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

	it('skips an oversized file without sending it', async () => {
		const outcome = await uploadEachFile({
			action: '?/upload',
			files: [file('big.jpg', 50)],
			maxBytes: 10,
			fallbackMessage: 'fallback'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(outcome.results[0]).toMatchObject({ fileName: 'big.jpg', ok: false, code: 'too-large' });
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
