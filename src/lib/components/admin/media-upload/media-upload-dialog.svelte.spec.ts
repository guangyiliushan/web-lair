import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { UploadOutcome } from '$lib/utils/upload-each';
import MediaUploadDialog from './media-upload-dialog.svelte';

/**
 * F-1: the batch must report progress as one polite announcement, and it must
 * never be left on "uploading" — not by a cancel, not by a session redirect.
 *
 * `uploadEachFile` runs for real here (it owns the AbortSignal merge and the
 * per-index state reporting); only the transport and the SvelteKit action
 * protocol are faked. `$app/forms.deserialize` is stubbed to JSON.parse so the
 * spec can hand back a plain ActionResult instead of devalue-encoded text.
 */

const { deserializeMock, applyActionMock, invalidateAllMock, fetchMock } = vi.hoisted(() => ({
	deserializeMock: vi.fn(),
	applyActionMock: vi.fn(async () => {}),
	invalidateAllMock: vi.fn(async () => {}),
	fetchMock: vi.fn()
}));

vi.mock('$app/forms', () => ({ deserialize: deserializeMock, applyAction: applyActionMock }));
vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }));

function fileOf(name: string, size = 4): File {
	return new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
}

function body(): HTMLElement {
	return document.body;
}

function attachments(): HTMLElement[] {
	return Array.from(body().querySelectorAll<HTMLElement>('[data-slot="attachment"]'));
}

function chipsInState(state: string): HTMLElement[] {
	return attachments().filter((el) => el.getAttribute('data-state') === state);
}

function progressRegion(): HTMLElement | null {
	return body().querySelector<HTMLElement>('[data-testid="upload-progress"]');
}

function progressLabel(): string {
	return progressRegion()?.textContent?.trim() ?? '';
}

function progressValue(): { value: number; max: number } | null {
	const bar = body().querySelector('[data-slot="progress"]');
	if (!bar) return null;
	return {
		value: Number(bar.getAttribute('aria-valuenow') ?? '0'),
		max: Number(bar.getAttribute('aria-valuemax') ?? '0')
	};
}

function button(name: string): HTMLElement {
	const found = Array.from(body().querySelectorAll('button')).find(
		(el) => el.textContent?.trim() === name
	);
	if (!found) throw new Error(`button not found: ${name}`);
	return found;
}

/** Drives the dropzone's own hidden picker — the same path a user's click takes. */
async function enqueue(files: File[]): Promise<void> {
	const picker = body().querySelector<HTMLInputElement>('input[type="file"]');
	if (!picker) throw new Error('file input not rendered');
	Object.defineProperty(picker, 'files', { value: files, configurable: true });
	picker.dispatchEvent(new Event('change', { bubbles: true }));
	await tick();
}

/** A pending fetch that only settles when its AbortSignal fires. */
function hangUntilAborted(): void {
	fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
		return new Promise((_resolve, reject) => {
			const signal = init?.signal as AbortSignal | undefined;
			signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
		});
	});
}

function okResult(fileNames: string[]) {
	deserializeMock.mockReturnValue({
		type: 'success',
		status: 200,
		data: {
			uploadResults: fileNames.map((fileName) => ({ fileName, ok: true }))
		}
	});
}

async function mount(resultNote?: (result: UploadOutcome) => string | undefined) {
	return render(MediaUploadDialog, {
		open: true,
		action: '?/upload',
		accept: '.jpg,.jpeg',
		maxBatch: 10,
		maxBytes: 10_000,
		description: 'spec upload dialog',
		resultNote
	});
}

beforeEach(() => {
	document.body.innerHTML = '';
	fetchMock.mockReset();
	deserializeMock.mockReset();
	applyActionMock.mockClear();
	invalidateAllMock.mockClear();
	deserializeMock.mockImplementation((text: string) => JSON.parse(text));
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
});

describe('media upload dialog', () => {
	it('announces batch progress politely and marks the queue busy while uploading', async () => {
		// Holds every request until released — uploadEachFile is sequential, so a
		// one-shot resolver only ever frees the file that is currently in flight.
		let hold = true;
		fetchMock.mockImplementation(async () => {
			while (hold) await new Promise((resolve) => setTimeout(resolve, 5));
			return {
				status: 200,
				text: async () => JSON.stringify({ type: 'success', status: 200, data: {} })
			};
		});
		okResult(['a.jpg', 'b.jpg']);
		await mount();
		await enqueue([fileOf('a.jpg'), fileOf('b.jpg')]);

		button(m.admin_media_upload()).click();

		// Gate on the batch actually being in flight: `submit()` is async, so a
		// bare tick after the click can land before the first request goes out.
		await vi.waitFor(() => expect(chipsInState('uploading')).toHaveLength(2), { timeout: 5000 });
		const group = body().querySelector('[data-slot="attachment-group"]');
		expect(group?.getAttribute('aria-busy')).toBe('true');
		expect(progressRegion()?.getAttribute('aria-live')).toBe('polite');
		expect(progressLabel()).toBe(m.admin_media_progress({ done: 0, total: 2 }));
		// The determinate bar lives only while the batch runs.
		expect(progressValue()).toEqual({ value: 0, max: 2 });

		hold = false;
		await vi.waitFor(
			() => expect(progressLabel()).toBe(m.admin_media_progress_done({ ok: 2, failed: 0 })),
			{ timeout: 5000 }
		);
		expect(chipsInState('uploading')).toHaveLength(0);
		expect(progressValue()).toBeNull();
		expect(group?.getAttribute('aria-busy')).toBe('false');
	});

	it('shows a success/failure summary once the batch settles', async () => {
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			const body = init?.body as FormData;
			const name = (body.get('files') as File).name;
			const ok = name === 'a.jpg';
			return {
				status: 200,
				text: async () =>
					JSON.stringify({
						type: ok ? 'success' : 'failure',
						status: ok ? 200 : 400,
						data: {
							uploadResults: [{ fileName: name, ok, message: ok ? undefined : 'nope' }]
						}
					})
			};
		});
		await mount();
		await enqueue([fileOf('a.jpg'), fileOf('b.jpg')]);
		button(m.admin_media_upload()).click();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 5000 });
		await vi.waitFor(
			() => expect(progressLabel()).toBe(m.admin_media_progress_done({ ok: 1, failed: 1 })),
			{ timeout: 5000 }
		);
		expect(chipsInState('done')).toHaveLength(1);
		expect(chipsInState('error')).toHaveLength(1);
	});

	it('cancels the in-flight request and leaves no chip on uploading', async () => {
		hangUntilAborted();
		await mount();
		await enqueue([fileOf('a.jpg'), fileOf('b.jpg')]);
		button(m.admin_media_upload()).click();

		await vi.waitFor(() => expect(chipsInState('uploading').length).toBeGreaterThan(0), {
			timeout: 5000
		});
		button(m.admin_media_cancel_upload()).click();

		await vi.waitFor(() => expect(chipsInState('uploading')).toHaveLength(0), { timeout: 5000 });
		// Only the first file was ever sent; the second is reported cancelled.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(progressLabel()).toBe(m.admin_media_progress_cancelled());
		expect(chipsInState('error')).toHaveLength(2);
	});

	it('closes out the rest of the queue when the session redirects mid-batch', async () => {
		fetchMock.mockResolvedValue({
			status: 200,
			text: async () => JSON.stringify({ type: 'redirect', status: 303, location: '/login' })
		});
		await mount();
		await enqueue([fileOf('a.jpg'), fileOf('b.jpg'), fileOf('c.jpg')]);
		button(m.admin_media_upload()).click();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 5000 });
		await vi.waitFor(() => expect(chipsInState('uploading')).toHaveLength(0), { timeout: 5000 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// The two that never went out are "cancelled", not stuck mid-flight.
		expect(attachments()).toHaveLength(3);
		expect(chipsInState('error')).toHaveLength(3);
	});

	it('keeps the result note on files that landed before a cancel', async () => {
		// First file resolves, second hangs until the user cancels.
		let calls = 0;
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			calls += 1;
			if (calls > 1) {
				return new Promise((_resolve, reject) => {
					const signal = init?.signal as AbortSignal | undefined;
					signal?.addEventListener('abort', () =>
						reject(new DOMException('Aborted', 'AbortError'))
					);
				});
			}
			return {
				status: 200,
				text: async () => JSON.stringify({ type: 'success', status: 200, data: {} })
			};
		});
		okResult(['a.jpg']);
		await mount(() => 'stored in gallery');
		await enqueue([fileOf('a.jpg'), fileOf('b.jpg')]);
		button(m.admin_media_upload()).click();

		// The cancel must not rewrite a landed file's status or its result note.
		await vi.waitFor(() => expect(chipsInState('done')).toHaveLength(1), { timeout: 5000 });
		button(m.admin_media_cancel_upload()).click();
		await vi.waitFor(() => expect(chipsInState('uploading')).toHaveLength(0), { timeout: 5000 });

		expect(chipsInState('done')).toHaveLength(1);
		expect(chipsInState('done')[0]?.textContent).toContain('stored in gallery');
		expect(chipsInState('error')).toHaveLength(1);
		expect(chipsInState('error')[0]?.textContent).toContain(m.admin_media_progress_cancelled());
	});
});
