import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import ImageInsertDialog from './ImageInsertDialog.svelte';

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
		fullUrl: `/i/${KEY}@full`,
		width: 1,
		height: 2,
		mimeType: 'image/png',
		byteSize: 3,
		createdAt: '2026-10-12T00:00:00.000Z',
		...overrides
	};
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe('ImageInsertDialog - three-source picker (ST-3 3a2)', () => {
	it('keeps the URL tab as the entry: insert fires with url and alt', async () => {
		const onInsert = vi.fn();
		await render(ImageInsertDialog, { open: true, onInsert });
		await page.getByLabelText('图片地址').fill('https://cdn.example/pic.png');
		await page.getByLabelText('图片描述（可选）').fill('demo');
		await page.getByRole('button', { name: '插入' }).click();
		expect(onInsert).toHaveBeenCalledWith('https://cdn.example/pic.png', 'demo');
	});

	it('loads the gallery tab on switch and inserts the preview url on click', async () => {
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
		expect(onInsert).toHaveBeenCalledWith(`/i/${KEY}@preview`, 'sunset');
	});

	it('searches server-side after a debounce', async () => {
		const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) =>
			okJson({ items: [] })
		);
		vi.stubGlobal('fetch', fetchMock);
		await render(ImageInsertDialog, { open: true, onInsert: vi.fn() });
		await page.getByRole('tab', { name: '内容资产' }).click();
		await page.getByLabelText('搜索名称…').fill('cover');
		await expect.poll(() => fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
			'/admin/editor-uploads?source=files&q=cover'
		);
	});

	it('shows the empty gallery copy and the list failure state', async () => {
		const fetchMock = vi.fn(async () => okJson({ items: [] }));
		vi.stubGlobal('fetch', fetchMock);
		await render(ImageInsertDialog, { open: true, onInsert: vi.fn() });
		await page.getByRole('tab', { name: '图床' }).click();
		await expect.element(page.getByText('图床里还没有照片。')).toBeInTheDocument();

		fetchMock.mockRejectedValueOnce(new Error('down'));
		await page.getByLabelText('搜索名称…').fill('zzz');
		await expect.element(page.getByText('列表加载失败。'), { timeout: 3000 }).toBeInTheDocument();
	});

	it('uploads through the assets tab and inserts each success', async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') return okJson({ url: `/i/${KEY}@preview` });
			return okJson({ items: [] });
		});
		vi.stubGlobal('fetch', fetchMock);
		const onInsert = vi.fn();
		await render(ImageInsertDialog, { open: true, onInsert });
		await page.getByRole('tab', { name: '内容资产' }).click();
		const input = document.querySelector<HTMLInputElement>('input[type="file"]');
		expect(input).not.toBeNull();
		const transfer = new DataTransfer();
		transfer.items.add(new File(['x'], 'cover.png', { type: 'image/png' }));
		input!.files = transfer.files;
		input!.dispatchEvent(new Event('change', { bubbles: true }));
		await expect.poll(() => onInsert.mock.calls.length).toBe(1);
		expect(onInsert).toHaveBeenCalledWith(`/i/${KEY}@preview`, 'cover');
	});

	it('reports an upload failure with its code', async () => {
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
		const transfer = new DataTransfer();
		transfer.items.add(new File(['x'], 'big.png', { type: 'image/png' }));
		input!.files = transfer.files;
		input!.dispatchEvent(new Event('change', { bubbles: true }));
		await expect
			.element(page.getByText('上传失败：too-large'), {
				timeout: 3000
			})
			.toBeInTheDocument();
	});
});
