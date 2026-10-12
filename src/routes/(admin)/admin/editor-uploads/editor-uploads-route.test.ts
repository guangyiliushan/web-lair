import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the editor upload endpoint (ST-3 3a / Q2 + Q10
 * rulings): the boolean auth surface (401/403 JSON, never a redirect), the
 * shared fail-open rate bucket, the `{code}` error envelope and the URL
 * shaping contract - GIFs take the bare key, everything else `@preview` +
 * `@full` (the bare non-GIF key is admin-only on /i).
 */
const { state, uploadMock } = vi.hoisted(() => {
	const state = {
		uploads: [] as Record<string, unknown>[],
		result: null as Record<string, unknown> | null,
		throwWith: null as Error | null,
		rate: { allowed: true, count: 1 },
		admin: true,
		user: true
	};
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
	return { state, uploadMock };
});

vi.mock('$lib/server/services/files', () => ({
	uploadFile: uploadMock,
	UploadRejected: class UploadRejected extends Error {
		constructor(
			public code: string,
			message: string
		) {
			super(message);
			this.name = 'UploadRejected';
		}
	}
}));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({
	rateLimit: vi.fn(async () => state.rate)
}));

import { POST } from './+server';
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

function fileForm(file: File | null, field = 'file'): FormData {
	const form = new FormData();
	if (file) form.set(field, file);
	return form;
}

beforeEach(() => {
	state.uploads = [];
	state.result = null;
	state.throwWith = null;
	state.rate = { allowed: true, count: 1 };
	state.admin = true;
	state.user = true;
	uploadMock.mockClear();
});

describe('POST /admin/editor-uploads', () => {
	it('answers 401 JSON to anonymous requests without redirecting', async () => {
		state.user = false;
		state.admin = false;
		const response = await POST(makeEvent(fileForm(new File(['x'], 'x.png'))));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ code: 'unauthorized' });
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

	it('rejects a missing or empty file field before the pipeline', async () => {
		const missing = await POST(makeEvent(fileForm(null)));
		expect(missing.status).toBe(400);
		const empty = await POST(makeEvent(fileForm(new File([], 'x.png'))));
		expect(empty.status).toBe(400);
		expect(await empty.json()).toEqual({ code: 'empty' });
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('rejects oversized files before copying the body', async () => {
		const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.png');
		const response = await POST(makeEvent(fileForm(big)));
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ code: 'too-large' });
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

	it('shapes @preview/@full URLs for a normal image and passes the file through', async () => {
		const response = await POST(makeEvent(fileForm(new File(['x'], 'screenshot.png'))));
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		const key = 'ab/ab' + 'a'.repeat(62) + '.png';
		expect(body).toMatchObject({
			id: 'f-1',
			objectKey: key,
			url: `/i/${key}@preview`,
			fullUrl: `/i/${key}@full`,
			width: 10,
			height: 20,
			mimeType: 'image/png',
			byteSize: 100,
			deduplicated: false
		});
		expect(state.uploads[0]).toMatchObject({ fileName: 'screenshot.png', uploadedBy: 'u1' });
		expect(state.uploads[0].bytes).toBeInstanceOf(Uint8Array);
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
