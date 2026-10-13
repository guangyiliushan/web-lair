import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import ImageInsertDialog from './ImageInsertDialog.svelte';
import ImageInsertDialogHost from './ImageInsertDialogHost.svelte';

// Pin the UI locale for the copy assertions (paraglide escape hatch).
overwriteGetLocale(() => 'zh-cn');

const KEY = 'ab/ab' + 'a'.repeat(62) + '.png';

function okJson(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function pickerItem(overrides: Record<string, unknown> = {}) {
	return {
		id: 'p-1',
		name: 'sunset',
		url: `/i/${KEY}@thumb`,
		previewUrl: `/i/${KEY}@preview`,
		width: 3000,
		height: 1500,
		...overrides
	};
}

function uploadResponse(overrides: Record<string, unknown> = {}) {
	return okJson({ url: `/i/${KEY}@preview`, width: 800, height: 600, ...overrides });
}

function selectFiles(input: HTMLInputElement, names: string[]) {
	const transfer = new DataTransfer();
	for (const name of names) transfer.items.add(new File(['x'], name, { type: 'image/png' }));
	input.files = transfer.files;
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe('ImageInsertDialog - three-source picker (ST-3 3a2, review rounds 1-2)', () => {
	it('keeps the URL tab as the entry: insert fires with url, alt and no tail', async () => {
		const onInsert = vi.fn();
		await render(ImageInsertDialog, { open: true, onInsert });
		await page.getByLabelText('图片地址').fill('https://cdn.example/pic.png');
		await page.getByLabelText('图片描述（可选）').fill('demo');
		await page.getByRole('button', { name: '插入' }).click();
		expect(onInsert).toHaveBeenCalledWith('https://cdn.example/pic.png', 'demo', '');
	});

	it('loads the gallery tab on switch and inserts with the tail dims on click', async () => {
		const fetchMock = vi.fn(async () => okJson({ items: [pickerItem()] }));
		vi.stubGlobal('fetch', fetchMock);
		const onInsert = vi.fn();
		await render(ImageInsertDialog, { open: true, onInsert });
		await page.getByRole('tab', { name: '图床' }).click();
		expect(fetchMock).toHaveBeenCalledWith('/admin/editor-uploads?source=photos', {
			headers: { accept: 'application/json' }
		});
		await expect.element(page.getByRole('button', { name: 'sunset' })).toBeInTheDocument();
		await page.getByRole('button', { name: 'sunset' }).click();
		expect(onInsert).toHaveBeenCalledWith(`/i/${KEY}@preview`, 'sunset', 'width=3000 height=1500');
	});

	it('debounces keystrokes: nothing inside the window, one coalesced request after', async () => {
		const urls: string[] = [];
		const fetchMock = vi.fn(async (input?: RequestInfo | URL) => {
			urls.push(String(input));
			return okJson({ items: [] });
		});
		vi.stubGlobal('fetch', fetchMock);
		await render(ImageInsertDialog, { open: true, onInsert: vi.fn() });
		await page.getByRole('tab', { name: '内容资产' }).click();
		expect(urls).toHaveLength(1); // the tab load itself
		const search = page.getByRole('textbox', { name: '搜索名称…' });
		await search.fill('c');
		expect(urls).toHaveLength(1); // still inside the debounce window
		await search.fill('co');
		await expect.poll(() => urls.length).toBe(2); // one coalesced request
		// settle: a broken clearTimeout would flush a late third request here
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(urls).toHaveLength(2);
		expect(urls.at(-1)).toBe('/admin/editor-uploads?source=files&q=co');
	});

	it('shows the empty gallery copy and the list failure state', async () => {
		const fetchMock = vi.fn(async () => okJson({ items: [] }));
		vi.stubGlobal('fetch', fetchMock);
		await render(ImageInsertDialog, { open: true, onInsert: vi.fn() });
		await page.getByRole('tab', { name: '图床' }).click();
		await expect.element(page.getByText('图床里还没有照片。')).toBeInTheDocument();

		fetchMock.mockRejectedValueOnce(new Error('down'));
		await page.getByRole('textbox', { name: '搜索名称…' }).fill('zzz');
		// Both panels render the shared list state (the inactive one stays
		// mounted but hidden), so the copy is asserted inside the active panel.
		await expect
			.element(page.getByRole('tabpanel', { name: '图床' }).getByText('列表加载失败。'), {
				timeout: 3000
			})
			.toBeInTheDocument();

		// A keyword with no hits says so instead of claiming an empty source.
		await page.getByRole('textbox', { name: '搜索名称…' }).fill('nope');
		await expect
			.element(page.getByRole('tabpanel', { name: '图床' }).getByText('没有找到匹配的条目'), {
				timeout: 3000
			})
			.toBeInTheDocument();
	});

	it('uploads through the assets tab: one POST per file, dims inserted, list refreshed', async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') return uploadResponse();
			return okJson({ items: [] });
		});
		vi.stubGlobal('fetch', fetchMock);
		const onInsert = vi.fn();
		await render(ImageInsertDialog, { open: true, onInsert });
		await page.getByRole('tab', { name: '内容资产' }).click();
		const input = document.querySelector<HTMLInputElement>('input[type="file"]');
		expect(input).not.toBeNull();
		await selectFiles(input!, ['cover [v2].png']);
		await expect.poll(() => onInsert.mock.calls.length).toBe(1);
		expect(onInsert).toHaveBeenCalledWith(`/i/${KEY}@preview`, 'cover v2', 'width=800 height=600');
		// The client half of the cross-process contract, pinned to literals:
		// multipart field `file` + `accept: application/json` on POST.
		const post = fetchMock.mock.calls.find(
			(call) => (call[1] as RequestInit | undefined)?.method === 'POST'
		);
		expect(post).toBeDefined();
		const init = post?.[1] as RequestInit;
		expect((init.headers as Record<string, string>).accept).toBe('application/json');
		expect((init.body as FormData).get('file')).toBeInstanceOf(File);
		// Stays open for the next pick and refetches the list after the batch.
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await expect.poll(() => fetchMock.mock.calls.length).toBe(3); // tab GET + POST + refresh GET
	});

	it('maps a failure code to localized copy and counts the skipped files', async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') {
				return new Response(JSON.stringify({ code: 'too-large' }), {
					status: 413,
					headers: { 'content-type': 'application/json' }
				});
			}
			return okJson({ items: [] });
		});
		vi.stubGlobal('fetch', fetchMock);
		await render(ImageInsertDialog, { open: true, onInsert: vi.fn() });
		await page.getByRole('tab', { name: '内容资产' }).click();
		const input = document.querySelector<HTMLInputElement>('input[type="file"]');
		expect(input).not.toBeNull();
		await selectFiles(input!, ['big.png', 'second.png']);
		await expect
			.element(page.getByText('上传失败：文件超过 25MB 上限'), { timeout: 3000 })
			.toBeInTheDocument();
		await expect.element(page.getByText('另有 1 个文件未上传')).toBeInTheDocument();
		// The batch stopped: the second file was never sent.
		const posts = fetchMock.mock.calls.filter(
			(call) => (call[1] as RequestInit | undefined)?.method === 'POST'
		);
		expect(posts).toHaveLength(1);
	});

	it('stops the whole batch when the dialog is closed mid-upload', async () => {
		let release: ((response: Response) => void) | null = null;
		const gate = new Promise<Response>((resolve) => (release = resolve));
		const posts: string[] = [];
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') {
				posts.push('post');
				if (posts.length === 1) return gate;
				return uploadResponse();
			}
			return okJson({ items: [] });
		});
		vi.stubGlobal('fetch', fetchMock);
		const onInsert = vi.fn();
		await render(ImageInsertDialog, { open: true, onInsert });
		await page.getByRole('tab', { name: '内容资产' }).click();
		const input = document.querySelector<HTMLInputElement>('input[type="file"]');
		expect(input).not.toBeNull();
		await selectFiles(input!, ['a.png', 'b.png']);
		await expect.poll(() => posts.length).toBe(1);
		await page.getByRole('button', { name: '取消' }).click();
		release!(uploadResponse());
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(posts).toHaveLength(1); // the second file was never sent
		expect(onInsert).not.toHaveBeenCalled();
	});

	it('resets through every close path: cancel and escape reopen clean', async () => {
		const fetchMock = vi.fn(async () => okJson({ items: [pickerItem()] }));
		vi.stubGlobal('fetch', fetchMock);
		const onInsert = vi.fn();
		await render(ImageInsertDialogHost, { onInsert });

		// Cancel path: switch tabs, close, reopen -> back on the URL tab.
		await page.getByRole('button', { name: 'open-picker' }).click();
		await page.getByRole('tab', { name: '图床' }).click();
		await expect.element(page.getByRole('button', { name: 'sunset' })).toBeInTheDocument();
		await page.getByRole('button', { name: '取消' }).click();
		await page.getByRole('button', { name: 'open-picker' }).click();
		// Inactive panels stay mounted but hidden (bits-ui Tabs), so the
		// clean-reopen contract is asserted through role visibility.
		await expect.element(page.getByRole('tabpanel', { name: '外链' })).toBeInTheDocument();
		await expect.element(page.getByRole('tabpanel', { name: '图床' })).not.toBeInTheDocument();

		// Escape path: open the assets tab, close by keyboard, reopen clean.
		await page.getByRole('tab', { name: '内容资产' }).click();
		await expect.element(page.getByRole('tabpanel', { name: '内容资产' })).toBeInTheDocument();
		await userEvent.keyboard('{Escape}');
		await page.getByRole('button', { name: 'open-picker' }).click();
		await expect.element(page.getByRole('tabpanel', { name: '外链' })).toBeInTheDocument();
		await expect.element(page.getByRole('tabpanel', { name: '内容资产' })).not.toBeInTheDocument();
	});

	it('exposes the APG tab contract: panel linkage and arrow-key switching', async () => {
		const fetchMock = vi.fn(async () => okJson({ items: [] }));
		vi.stubGlobal('fetch', fetchMock);
		await render(ImageInsertDialog, { open: true, onInsert: vi.fn() });

		const tabs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
		const panel = () => document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
		await expect
			.element(page.getByRole('tab', { name: '外链' }))
			.toHaveAttribute('aria-selected', 'true');
		// The half-fixed regression this pins: without Tabs.Content the trigger's
		// aria-controls is undefined and no tabpanel exists (bits-ui only links
		// triggers to registered content).
		expect(tabs()[0]?.getAttribute('aria-controls')).toBe(panel()?.id);
		expect(panel()?.getAttribute('aria-labelledby')).toBe(tabs()[0]?.id);

		tabs()[0]?.focus();
		await userEvent.keyboard('{ArrowRight}');
		await expect
			.element(page.getByRole('tab', { name: '图床' }))
			.toHaveAttribute('aria-selected', 'true');
		expect(tabs()[1]?.getAttribute('aria-controls')).toBe(panel()?.id);
		expect(panel()?.getAttribute('aria-labelledby')).toBe(tabs()[1]?.id);
	});

	it('focuses the URL input when the dialog opens', async () => {
		await render(ImageInsertDialog, { open: true, onInsert: vi.fn() });
		await expect.poll(() => document.activeElement?.id).toBe('image-url');
	});

	it('ignores a double click on a tile: a single insert', async () => {
		const fetchMock = vi.fn(async () => okJson({ items: [pickerItem()] }));
		vi.stubGlobal('fetch', fetchMock);
		const onInsert = vi.fn();
		await render(ImageInsertDialog, { open: true, onInsert });
		await page.getByRole('tab', { name: '图床' }).click();
		const tile = page.getByRole('button', { name: 'sunset' });
		await expect.element(tile).toBeInTheDocument();
		// Two synchronous clicks (what a double click fires); the second must
		// not insert again.
		const tileEl = document.querySelector<HTMLButtonElement>('ul button[aria-label="sunset"]');
		expect(tileEl).not.toBeNull();
		tileEl!.click();
		tileEl!.click();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(onInsert).toHaveBeenCalledTimes(1);
	});

	it('swaps a broken thumbnail for the placeholder tile', async () => {
		const fetchMock = vi.fn(async () => okJson({ items: [pickerItem()] }));
		vi.stubGlobal('fetch', fetchMock);
		await render(ImageInsertDialog, { open: true, onInsert: vi.fn() });
		await page.getByRole('tab', { name: '图床' }).click();
		await expect.element(page.getByRole('button', { name: 'sunset' })).toBeInTheDocument();
		// The thumb request may fail on its own in this environment; drive the
		// fallback deterministically either way and assert the end state.
		const img = document.querySelector<HTMLImageElement>('ul img');
		if (img) img.dispatchEvent(new Event('error'));
		await expect.poll(() => document.querySelector('ul img')).toBeNull();
		expect(document.querySelector('ul svg')).not.toBeNull();
	});
});
