import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the editor upload endpoint (ST-3 3a / Q2 + Q10
 * rulings; review rounds 1-2): the boolean auth surface (401/403 JSON, never a
 * redirect), the shared fail-open rate bucket asserted with its exact
 * arguments, the image-only gate, the `{code}` error envelope (both verbs)
 * and the URL shaping contract - body embeds follow object existence (GIFs
 * take the bare key, `@preview` only above the preview box, `@full`
 * otherwise).
 */
const { state, uploadMock, listFilesMock, photosMock, sniffMock } = vi.hoisted(() => {
	const state = {
		uploads: [] as Record<string, unknown>[],
		result: null as Record<string, unknown> | null,
		throwWith: null as Error | null,
		rate: { allowed: true, count: 1 },
		rateCalls: [] as unknown[][],
		admin: true,
		user: true,
		fileRows: [] as Record<string, unknown>[],
		photoRows: [] as Record<string, unknown>[],
		fileCalls: [] as Record<string, unknown>[],
		photoCalls: [] as Record<string, unknown>[],
		sniffKind: 'image' as 'image' | 'file' | null,
		sniffCalls: [] as { fileName: string; byteLength: number }[]
	};
	const listFilesMock = vi.fn(async (filters: Record<string, unknown>) => {
		state.fileCalls.push(filters);
		return state.fileRows;
	});
	const photosMock = vi.fn(async (filters: Record<string, unknown>) => {
		state.photoCalls.push(filters);
		return state.photoRows;
	});
	const sniffMock = vi.fn((fileName: string, bytes: Uint8Array) => {
		state.sniffCalls.push({ fileName, byteLength: bytes.byteLength });
		if (state.sniffKind === null) return null;
		return {
			kind: state.sniffKind,
			ext: 'png',
			mimeType: state.sniffKind === 'image' ? 'image/png' : 'application/pdf'
		};
	});
	const uploadMock = vi.fn(async (input: Record<string, unknown>) => {
		state.uploads.push(input);
		if (state.throwWith) throw state.throwWith;
		return (
			state.result ?? {
				id: 'f-1',
				objectKey: 'ab/ab' + 'a'.repeat(62) + '.png',
				fileName: 'x.png',
				mimeType: 'image/png',
				byteSize: 100,
				width: 10,
				height: 20,
				status: 'pending',
				deduplicated: false
			}
		);
	});
	return { state, uploadMock, listFilesMock, photosMock, sniffMock };
});

vi.mock('$lib/server/services/files', () => ({
	uploadFile: uploadMock,
	listFiles: listFilesMock,
	UploadRejected: class UploadRejected extends Error {
		constructor(
			public code: string,
			message: string
		) {
			super(message);
			this.name = 'UploadRejected';
		}
	},
	// Mirrors of the real single-source constants; the real module is
	// re-imported below to weld the two spellings.
	UPLOAD_RATE_LIMIT: { limit: 60, windowSeconds: 10 * 60 },
	uploadRateLimitKey: (userId: string | null | undefined) =>
		`limits:upload:${userId ?? 'anonymous'}`
}));
vi.mock('$lib/server/services/photos', () => ({ listAdminPhotos: photosMock }));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({
	rateLimit: vi.fn(async (...args: unknown[]) => {
		state.rateCalls.push(args);
		return state.rate;
	})
}));
vi.mock('$lib/server/media/sniff', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/media/sniff')>();
	return { ...actual, sniffUpload: sniffMock };
});

import { GET, POST } from './+server';
import { UploadRejected } from '$lib/server/services/files';
import { MAX_UPLOAD_BYTES } from '$lib/server/media/sniff';

function makeEvent(body?: BodyInit) {
	return {
		request: new Request('http://localhost/admin/editor-uploads', {
			method: 'POST',
			...(body ? { body } : {})
		}),
		locals: {
			admin: state.admin ? { userId: 'a1' } : null,
			user: state.user ? { id: 'u1' } : null
		}
	} as never;
}

function fileForm(file: File | null): FormData {
	const form = new FormData();
	if (file) form.set('file', file);
	return form;
}

beforeEach(() => {
	state.uploads = [];
	state.result = null;
	state.throwWith = null;
	state.rate = { allowed: true, count: 1 };
	state.rateCalls = [];
	state.admin = true;
	state.user = true;
	state.fileRows = [];
	state.photoRows = [];
	state.fileCalls = [];
	state.photoCalls = [];
	state.sniffKind = 'image';
	state.sniffCalls = [];
	uploadMock.mockClear();
	listFilesMock.mockClear();
	photosMock.mockClear();
	sniffMock.mockClear();
});

describe('POST /admin/editor-uploads', () => {
	it('answers 401 JSON to anonymous requests without redirecting', async () => {
		state.user = false;
		state.admin = false;
		const response = await POST(makeEvent(fileForm(new File(['x'], 'x.png'))));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ code: 'unauthorized' });
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('answers 403 JSON to signed-in non-admins', async () => {
		state.admin = false;
		const response = await POST(makeEvent(fileForm(new File(['x'], 'x.png'))));
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: 'forbidden' });
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('maps the shared rate bucket rejection to 429', async () => {
		state.rate = { allowed: false, count: 61 };
		const response = await POST(makeEvent(fileForm(new File(['x'], 'x.png'))));
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({ code: 'throttled' });
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('throttles through the shared upload bucket with its exact arguments', async () => {
		await POST(makeEvent(fileForm(new File(['x'], 'x.png'))));
		expect(state.rateCalls[0]).toEqual([{}, 'limits:upload:u1', 60, 600]);
		// Weld the mirrors to the real module (single source in files.ts).
		const actual = await vi.importActual<typeof import('$lib/server/services/files')>(
			'$lib/server/services/files'
		);
		expect(actual.UPLOAD_RATE_LIMIT).toEqual({ limit: 60, windowSeconds: 600 });
		expect(actual.uploadRateLimitKey('u1')).toBe('limits:upload:u1');
		expect(actual.uploadRateLimitKey(null)).toBe('limits:upload:anonymous');
		// The dynamic importActual pulls the real server module chain (storage,
		// sharp), which can cost seconds on a cold run - explicit budget.
	}, 15_000);

	it('rejects a missing or empty file field before the pipeline', async () => {
		const missing = await POST(makeEvent(fileForm(null)));
		expect(missing.status).toBe(400);
		const empty = await POST(makeEvent(fileForm(new File([], 'x.png'))));
		expect(empty.status).toBe(400);
		expect(await empty.json()).toEqual({ code: 'empty' });
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('rejects oversized files before the byte copy and the pipeline', async () => {
		const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.png');
		const response = await POST(makeEvent(fileForm(big)));
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ code: 'too-large' });
		expect(uploadMock).not.toHaveBeenCalled();
		expect(sniffMock).not.toHaveBeenCalled();
	});

	it('lets a file exactly at the size cap through', async () => {
		const edge = new File([new Uint8Array(MAX_UPLOAD_BYTES)], 'edge.png');
		const response = await POST(makeEvent(fileForm(edge)));
		expect(response.status).toBe(200);
		expect(state.sniffCalls[0]?.byteLength).toBe(MAX_UPLOAD_BYTES);
		expect(uploadMock).toHaveBeenCalledTimes(1);
	});

	it('answers 415 to whitelisted non-image uploads (image-only gate)', async () => {
		state.sniffKind = 'file';
		const response = await POST(makeEvent(fileForm(new File(['%PDF-1.7'], 'doc.pdf'))));
		expect(response.status).toBe(415);
		expect(await response.json()).toEqual({ code: 'unsupported-type' });
		expect(state.sniffCalls[0]?.fileName).toBe('doc.pdf');
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('answers 415 to sniff-unknown uploads', async () => {
		state.sniffKind = null;
		const response = await POST(makeEvent(fileForm(new File(['junk'], 'x.bin'))));
		expect(response.status).toBe(415);
		expect(await response.json()).toEqual({ code: 'unsupported-type' });
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('maps pipeline rejections onto their codes', async () => {
		for (const [code, status] of [
			['too-large', 413],
			['unsupported-type', 415],
			['empty', 400]
		] as const) {
			state.throwWith = new UploadRejected(code, code);
			const response = await POST(makeEvent(fileForm(new File(['x'], 'x.png'))));
			expect(response.status, code).toBe(status);
			expect(await response.json(), code).toEqual({ code });
		}
	});

	it('answers a sanitized 500 when the pipeline blows up', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		state.throwWith = new Error('driver said something secret');
		const response = await POST(makeEvent(fileForm(new File(['x'], 'x.png'))));
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ code: 'server-error' });
		expect(warn).toHaveBeenCalledWith('[editor-uploads] upload failed', { error: 'Error' });
		expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
		warn.mockRestore();
	});

	it('embeds small sources as @full (preview does not exist below the box)', async () => {
		const response = await POST(makeEvent(fileForm(new File(['x'], 'screenshot.png'))));
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		const key = 'ab/ab' + 'a'.repeat(62) + '.png';
		expect(body).toMatchObject({
			id: 'f-1',
			objectKey: key,
			url: `/i/${key}@full`,
			fullUrl: `/i/${key}@full`,
			width: 10,
			height: 20,
			mimeType: 'image/png',
			byteSize: 100,
			deduplicated: false
		});
		expect(state.uploads[0]).toMatchObject({ fileName: 'screenshot.png', uploadedBy: 'u1' });
		expect(Array.from(state.uploads[0].bytes as Uint8Array)).toEqual([120]);
	});

	it('embeds large sources as @preview with @full alongside', async () => {
		const key = 'ab/ab' + 'a'.repeat(62) + '.png';
		state.result = {
			id: 'f-3',
			objectKey: key,
			fileName: 'big.png',
			mimeType: 'image/png',
			byteSize: 300,
			width: 3000,
			height: 2000,
			status: 'pending',
			deduplicated: false
		};
		const response = await POST(makeEvent(fileForm(new File(['x'], 'big.png'))));
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.url).toBe(`/i/${key}@preview`);
		expect(body.fullUrl).toBe(`/i/${key}@full`);
	});

	it('keeps the bare key for GIFs and echoes dedupe hits', async () => {
		state.result = {
			id: 'f-2',
			objectKey: 'cd/cd' + 'd'.repeat(62) + '.gif',
			fileName: 'loop.gif',
			mimeType: 'image/gif',
			byteSize: 200,
			width: 4,
			height: 4,
			status: 'pending',
			deduplicated: true
		};
		const response = await POST(makeEvent(fileForm(new File(['x'], 'loop.gif'))));
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.url).toBe('/i/cd/cd' + 'd'.repeat(62) + '.gif');
		expect(body.fullUrl).toBe(body.url);
		expect(body.deduplicated).toBe(true);
	});
});

function makeGetEvent(search = '') {
	return {
		url: new URL(`http://localhost/admin/editor-uploads${search}`),
		locals: {
			admin: state.admin ? { userId: 'a1' } : null,
			user: state.user ? { id: 'u1' } : null
		}
	} as never;
}

const FILE_KEY = 'ab/ab' + 'a'.repeat(62) + '.png';
const GIF_KEY = 'cd/cd' + 'd'.repeat(62) + '.gif';

function fileRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'file-1',
		objectKey: FILE_KEY,
		fileName: 'cover.png',
		mimeType: 'image/png',
		byteSize: 10,
		width: 1,
		height: 2,
		status: 'pending',
		createdAt: new Date('2026-10-12T00:00:00Z'),
		refCount: 0,
		isInGallery: false,
		...overrides
	};
}

describe('GET /admin/editor-uploads (picker data)', () => {
	it('answers 401/403 like POST', async () => {
		state.user = false;
		state.admin = false;
		expect((await GET(makeGetEvent())).status).toBe(401);
		state.user = true;
		expect((await GET(makeGetEvent())).status).toBe(403);
		expect(listFilesMock).not.toHaveBeenCalled();
	});

	it('serves files: search passthrough, embed tier by dimensions, cache header', async () => {
		state.fileRows = [fileRow()];
		const response = await GET(makeGetEvent('?source=files&q=cover'));
		expect(listFilesMock).toHaveBeenCalledWith({ kind: 'image', keyword: 'cover' });
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.json()).toEqual({
			items: [
				{
					id: 'file-1',
					name: 'cover.png',
					url: `/i/${FILE_KEY}@thumb`,
					previewUrl: `/i/${FILE_KEY}@full`,
					width: 1,
					height: 2
				}
			]
		});
	});

	it('derives the embed tier from the row dimensions (large source)', async () => {
		state.fileRows = [fileRow({ width: 3000, height: 1500 })];
		const body = (await (await GET(makeGetEvent())).json()) as {
			items: Array<Record<string, unknown>>;
		};
		expect(body.items[0].previewUrl).toBe(`/i/${FILE_KEY}@preview`);
	});

	it('serves photos by slug with the GIF bare-key rule', async () => {
		state.photoRows = [
			{
				id: 'photo-1',
				slug: 'sunset',
				objectKey: GIF_KEY,
				fileName: 'sunset.gif',
				mimeType: 'image/gif',
				byteSize: 20,
				width: 3,
				height: 4,
				createdAt: new Date('2026-10-11T00:00:00Z')
			}
		];
		const response = await GET(makeGetEvent('?source=photos&q=sun'));
		expect(photosMock).toHaveBeenCalledWith({ slugKeyword: 'sun', visibility: true });
		const body = (await response.json()) as { items: Array<Record<string, unknown>> };
		expect(body.items[0]).toEqual({
			id: 'photo-1',
			name: 'sunset',
			url: `/i/${GIF_KEY}`,
			previewUrl: `/i/${GIF_KEY}`,
			width: 3,
			height: 4
		});
	});

	it('trims the keyword and falls back to files for unknown sources', async () => {
		await GET(makeGetEvent('?source=bogus&q=%20%20cover%20%20'));
		expect(photosMock).not.toHaveBeenCalled();
		expect(listFilesMock).toHaveBeenCalledWith({ kind: 'image', keyword: 'cover' });
	});

	it('caps the search keyword length server-side', async () => {
		await GET(makeGetEvent(`?source=files&q=${'x'.repeat(150)}`));
		expect(listFilesMock).toHaveBeenCalledWith({ kind: 'image', keyword: 'x'.repeat(100) });
	});

	it('caps the list at 60', async () => {
		state.fileRows = Array.from({ length: 62 }, (_, i) => fileRow({ id: `file-${i}` }));
		const body = (await (await GET(makeGetEvent())).json()) as { items: unknown[] };
		expect(body.items).toHaveLength(60);
	});

	it('answers a sanitized 500 with the {code} envelope when the list fails', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		listFilesMock.mockRejectedValueOnce(new Error('db said something secret'));
		const response = await GET(makeGetEvent());
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ code: 'server-error' });
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(warn).toHaveBeenCalledWith('[editor-uploads] list failed', { error: 'Error' });
		expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
		warn.mockRestore();
	});
});
