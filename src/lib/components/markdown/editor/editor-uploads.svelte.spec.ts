import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	mountEditorFixture,
	readSaved
} from '$lib/components/markdown/testing/editor-spec-helpers';

// Paste/drop uploads (ST-3 3a3): the pipeline rides the DRAG_DROP_PASTE
// command that @lexical/rich-text dispatches for local pasted/dropped files.

const KEY = 'ab/ab' + 'a'.repeat(62) + '.png';

function okJson(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function uploadBody(overrides: Record<string, unknown> = {}) {
	return {
		id: 'f-1',
		objectKey: KEY,
		url: `/i/${KEY}@preview`,
		fullUrl: `/i/${KEY}@full`,
		width: 800,
		height: 600,
		mimeType: 'image/png',
		byteSize: 3,
		deduplicated: false,
		...overrides
	};
}

function editorRoot(container: Element): HTMLElement {
	const root = container.querySelector<HTMLElement>('[data-lexical-editor="true"]');
	expect(root).not.toBeNull();
	return root!;
}

function filesTransfer(files: File[]): DataTransfer {
	const dataTransfer = new DataTransfer();
	for (const file of files) dataTransfer.items.add(file);
	return dataTransfer;
}

function pasteFiles(root: HTMLElement, files: File[]): void {
	const dataTransfer = filesTransfer(files);
	let event: ClipboardEvent;
	try {
		event = new ClipboardEvent('paste', {
			bubbles: true,
			cancelable: true,
			clipboardData: dataTransfer
		});
	} catch {
		event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
	}
	if (!event.clipboardData) Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
	root.dispatchEvent(event);
}

function dropFiles(root: HTMLElement, files: File[]): void {
	const dataTransfer = filesTransfer(files);
	const rect = root.getBoundingClientRect();
	root.dispatchEvent(
		new DragEvent('drop', {
			bubbles: true,
			cancelable: true,
			dataTransfer,
			clientX: rect.left + 40,
			clientY: rect.top + 24
		})
	);
}

function posts(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
	return fetchMock.mock.calls.filter(
		(call) => (call[1] as RequestInit | undefined)?.method === 'POST'
	);
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe('editor paste/drop uploads (ST-3 3a3)', () => {
	it('pastes local images: one POST each, inserted with dims as they land', async () => {
		const fetchMock = vi.fn(async () => okJson(uploadBody()));
		vi.stubGlobal('fetch', fetchMock);
		const { screen } = await mountEditorFixture('');
		pasteFiles(editorRoot(screen.container), [
			new File(['x'], 'one.png', { type: 'image/png' }),
			new File(['y'], 'two.png', { type: 'image/png' })
		]);

		await expect
			.poll(() => readSaved(screen.container), { timeout: 15_000 })
			.toContain('![one](/i/');
		const saved = readSaved(screen.container);
		expect(saved).toContain('@preview) {width=800 height=600}');
		expect(saved).toContain('![two](');

		const calls = posts(fetchMock);
		expect(calls).toHaveLength(2);
		const init = calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).accept).toBe('application/json');
		expect((init.body as FormData).get('file')).toBeInstanceOf(File);

		// The image nodes render in the editor itself, not just in the export.
		await expect
			.poll(() => document.querySelectorAll('[data-lexical-editor] img').length, {
				timeout: 15_000
			})
			.toBe(2);
	});

	it('maps a throttled failure to localized copy and inserts nothing', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ code: 'throttled' }), {
					status: 429,
					headers: { 'content-type': 'application/json' }
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		const { screen } = await mountEditorFixture('');
		pasteFiles(editorRoot(screen.container), [new File(['x'], 'slow.png', { type: 'image/png' })]);

		await expect
			.element(page.getByText('上传失败：操作太频繁，请稍后再试'), { timeout: 3000 })
			.toBeInTheDocument();
		expect(readSaved(screen.container)).not.toContain('![');
	});

	it('routes dropped files through the same pipeline', async () => {
		const fetchMock = vi.fn(async () => okJson(uploadBody({ width: 3000, height: 1500 })));
		vi.stubGlobal('fetch', fetchMock);
		const { screen } = await mountEditorFixture('');
		dropFiles(editorRoot(screen.container), [new File(['x'], 'drop.png', { type: 'image/png' })]);

		await expect
			.poll(() => readSaved(screen.container), { timeout: 15_000 })
			.toContain('![drop](/i/');
		expect(posts(fetchMock)).toHaveLength(1);
		expect(readSaved(screen.container)).toContain('@preview) {width=3000 height=1500}');
	});

	it('caps concurrency at three while processing every file', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const gates: Array<(response: Response) => void> = [];
		const fetchMock = vi.fn(async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			return new Promise<Response>((resolve) => {
				gates.push((response) => {
					inFlight -= 1;
					resolve(response);
				});
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const { screen } = await mountEditorFixture('');
		const files = Array.from(
			{ length: 5 },
			(_, i) => new File(['x'], `pic-${i}.png`, { type: 'image/png' })
		);
		pasteFiles(editorRoot(screen.container), files);

		// The pool starts exactly three files; the fourth only leaves the gate
		// queue when one of the first three settles.
		await expect.poll(() => gates.length, { timeout: 5000 }).toBe(3);
		expect(maxInFlight).toBe(3);
		gates.shift()!(okJson(uploadBody()));
		await expect.poll(() => gates.length, { timeout: 5000 }).toBe(3);

		// Drain everything arriving until all five land in the document.
		await expect
			.poll(
				() => {
					while (gates.length > 0) gates.shift()!(okJson(uploadBody()));
					return readSaved(screen.container).includes('![pic-4]');
				},
				{ timeout: 15_000 }
			)
			.toBe(true);
		expect(fetchMock.mock.calls.length).toBe(5);
		expect(maxInFlight).toBeLessThanOrEqual(3);
	});
});
