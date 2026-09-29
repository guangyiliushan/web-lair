import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MAX_UPLOAD_BYTES } from '$lib/server/media/sniff';
import type { StoredObjectBody, StoredObjectHead } from '$lib/server/storage/port';

const dbMock = vi.hoisted(() => ({
	select: vi.fn(),
	insert: vi.fn(),
	delete: vi.fn(),
	$count: vi.fn()
}));
const storageMock = vi.hoisted(() => ({
	put: vi.fn<
		(key: string, data: Uint8Array, options?: { contentType?: string }) => Promise<{ etag: string }>
	>(async () => ({ etag: '"etag"' })),
	delete: vi.fn<(key: string) => Promise<void>>(async () => {}),
	head: vi.fn<(key: string) => Promise<StoredObjectHead | null>>(async () => null),
	get: vi.fn<(key: string) => Promise<StoredObjectBody | null>>(async () => null),
	ensureBucket: vi.fn<() => Promise<void>>(async () => {})
}));
const processImageMock = vi.hoisted(() => vi.fn());
const getOptionMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/storage', () => ({ getStorage: () => storageMock }));
vi.mock('$lib/server/media/variants', () => ({ processImage: processImageMock }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: getOptionMock }));

import { deleteFile, listPurgeCandidates, uploadFile, uploadFiles } from './files';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const HASH = createHash('sha256').update(JPEG).digest('hex');
const BASE_KEY = `${HASH.slice(0, 2)}/${HASH}.jpg`;

const EXISTING_ROW = {
	id: 'file-1',
	objectKey: BASE_KEY,
	fileName: 'photo.jpg',
	mimeType: 'image/jpeg',
	byteSize: JPEG.byteLength,
	width: 10,
	height: 10,
	status: 'pending'
};

interface SelectChain {
	from: () => SelectChain;
	where: () => SelectChain;
	orderBy: () => SelectChain;
	limit: () => Promise<unknown[]>;
}

function selectChain(rows: unknown[]): SelectChain {
	const chain: SelectChain = {
		from: vi.fn(() => chain),
		where: vi.fn(() => chain),
		orderBy: vi.fn(() => chain),
		limit: vi.fn(async () => rows)
	};
	return chain;
}

interface InsertChain {
	values: () => InsertChain;
	returning: () => Promise<unknown[]>;
}

function insertChain(result: unknown[] | Error): InsertChain {
	const chain: InsertChain = {
		values: vi.fn(() => chain),
		returning: vi.fn(async () => {
			if (result instanceof Error) throw result;
			return result;
		})
	};
	return chain;
}

function deleteChain() {
	return { where: vi.fn(async () => {}) };
}

const PROCESSED = {
	width: 64,
	height: 32,
	variants: { thumb: Buffer.from('thumb'), preview: null, full: Buffer.from('full') },
	thumbhash: 'TH',
	palette: { dominant: [1, 2, 3] }
};

beforeEach(() => {
	vi.clearAllMocks();
	getOptionMock.mockResolvedValue({ pendingDays: 7, detachedDays: 30 });
	storageMock.put.mockResolvedValue({ etag: '"etag"' });
	storageMock.delete.mockResolvedValue(undefined);
});

describe('uploadFile', () => {
	it('rejects empty, oversized and unsupported uploads before touching db or storage', async () => {
		await expect(
			uploadFile({ fileName: 'x.jpg', bytes: new Uint8Array() }, { storage: storageMock })
		).rejects.toMatchObject({ code: 'empty' });
		await expect(
			uploadFile(
				{ fileName: 'big.jpg', bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) },
				{ storage: storageMock }
			)
		).rejects.toMatchObject({ code: 'too-large' });
		await expect(
			uploadFile(
				{ fileName: 'payload.exe', bytes: Uint8Array.from([1, 2, 3, 4]) },
				{ storage: storageMock }
			)
		).rejects.toMatchObject({ code: 'unsupported-type' });
		expect(dbMock.select).not.toHaveBeenCalled();
		expect(storageMock.put).not.toHaveBeenCalled();
	});

	it('reuses the existing row when content_hash is already registered', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([EXISTING_ROW]));

		const result = await uploadFile(
			{ fileName: 'renamed.jpg', bytes: JPEG, uploadedBy: 'u1' },
			{ storage: storageMock }
		);

		expect(result).toEqual({ ...EXISTING_ROW, deduplicated: true });
		expect(storageMock.put).not.toHaveBeenCalled();
		expect(dbMock.insert).not.toHaveBeenCalled();
	});

	it('uploads original + variants then writes the registry row (zero orphans)', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce(PROCESSED);
		dbMock.insert.mockReturnValueOnce(
			insertChain([{ ...EXISTING_ROW, width: 64, height: 32, status: 'pending' }])
		);

		const result = await uploadFile(
			{ fileName: 'photo.jpg', bytes: JPEG, uploadedBy: 'u1' },
			{ storage: storageMock }
		);

		expect(result.deduplicated).toBe(false);
		expect(storageMock.put.mock.calls.map((call) => call[0])).toEqual([
			BASE_KEY,
			`${BASE_KEY}@thumb`,
			`${BASE_KEY}@full`
		]);
		const values = dbMock.insert.mock.results[0].value.values.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(values).toMatchObject({
			objectKey: BASE_KEY,
			contentHash: HASH,
			byteSize: JPEG.byteLength,
			width: 64,
			height: 32,
			thumbhash: 'TH',
			uploadedBy: 'u1'
		});
	});

	it('compensates by deleting uploaded objects when the registry write fails', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce(PROCESSED);
		dbMock.insert.mockReturnValueOnce(insertChain(new Error('db exploded')));

		await expect(
			uploadFile({ fileName: 'photo.jpg', bytes: JPEG }, { storage: storageMock })
		).rejects.toThrow('db exploded');

		expect(storageMock.delete.mock.calls.map((call) => call[0])).toEqual([
			BASE_KEY,
			`${BASE_KEY}@thumb`,
			`${BASE_KEY}@full`
		]);
	});

	it('does not delete shared objects when losing a content_hash race (23505)', async () => {
		const duplicate = Object.assign(new Error('duplicate key'), { cause: { code: '23505' } });
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce(PROCESSED);
		dbMock.insert.mockReturnValueOnce(insertChain(duplicate));
		dbMock.select.mockReturnValueOnce(selectChain([EXISTING_ROW]));

		const result = await uploadFile(
			{ fileName: 'photo.jpg', bytes: JPEG },
			{ storage: storageMock }
		);

		expect(result).toEqual({ ...EXISTING_ROW, deduplicated: true });
		// The winner's objects are content-addressed and SHARED — deleting them
		// would break the row that just won the race.
		expect(storageMock.delete).not.toHaveBeenCalled();
	});
});

describe('uploadFiles', () => {
	it('rejects batches over the cap', async () => {
		const inputs = Array.from({ length: 11 }, (_, index) => ({
			fileName: `f${index}.jpg`,
			bytes: JPEG
		}));
		await expect(uploadFiles(inputs, { storage: storageMock })).rejects.toMatchObject({
			code: 'batch-too-large'
		});
	});

	it('reports per item without aborting the batch', async () => {
		const results = await uploadFiles(
			[{ fileName: 'payload.exe', bytes: Uint8Array.from([1, 2, 3]) }],
			{ storage: storageMock }
		);
		expect(results).toEqual([
			{ fileName: 'payload.exe', ok: false, code: 'unsupported-type', message: expect.any(String) }
		]);
	});
});

describe('deleteFile', () => {
	it('returns not-found for unknown ids', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		expect(await deleteFile('missing', { storage: storageMock })).toEqual({ kind: 'not-found' });
	});

	it('blocks deletion while content or the gallery still references the file', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'file-1', objectKey: BASE_KEY }]));
		dbMock.$count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

		expect(await deleteFile('file-1', { storage: storageMock })).toEqual({
			kind: 'referenced',
			refCount: 1,
			isPhoto: false
		});
		expect(storageMock.delete).not.toHaveBeenCalled();

		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'file-1', objectKey: BASE_KEY }]));
		dbMock.$count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
		expect(await deleteFile('file-1', { storage: storageMock })).toEqual({
			kind: 'referenced',
			refCount: 0,
			isPhoto: true
		});
	});

	it('deletes objects first and the registry row last when unreferenced', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'file-1', objectKey: BASE_KEY }]));
		dbMock.$count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
		dbMock.delete.mockReturnValueOnce(deleteChain());

		expect(await deleteFile('file-1', { storage: storageMock })).toEqual({
			kind: 'ok',
			objectKey: BASE_KEY
		});
		expect(storageMock.delete.mock.calls.map((call) => call[0])).toEqual([
			BASE_KEY,
			`${BASE_KEY}@thumb`,
			`${BASE_KEY}@preview`,
			`${BASE_KEY}@full`
		]);
		expect(dbMock.delete).toHaveBeenCalledTimes(1);
	});
});

describe('listPurgeCandidates', () => {
	it('applies the media.purge TTLs (pending 7d / detached 30d)', async () => {
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		dbMock.select.mockReturnValueOnce(
			selectChain([
				{
					id: 'a',
					objectKey: 'aa/a.jpg',
					fileName: 'a.jpg',
					status: 'pending',
					createdAt: new Date(now - 8 * day),
					detachedAt: null,
					updatedAt: new Date(now)
				},
				{
					id: 'b',
					objectKey: 'bb/b.jpg',
					fileName: 'b.jpg',
					status: 'pending',
					createdAt: new Date(now - 1 * day),
					detachedAt: null,
					updatedAt: new Date(now)
				},
				{
					id: 'c',
					objectKey: 'cc/c.jpg',
					fileName: 'c.jpg',
					status: 'detached',
					createdAt: new Date(now - 60 * day),
					detachedAt: new Date(now - 31 * day),
					updatedAt: new Date(now - 31 * day)
				},
				{
					id: 'd',
					objectKey: 'dd/d.jpg',
					fileName: 'd.jpg',
					status: 'detached',
					createdAt: new Date(now - 60 * day),
					detachedAt: new Date(now - 10 * day),
					updatedAt: new Date(now - 10 * day)
				}
			])
		);

		const candidates = await listPurgeCandidates();

		expect(candidates.map((candidate) => candidate.id)).toEqual(['a', 'c']);
		expect(candidates[0].ageDays).toBe(8);
		expect(getOptionMock).toHaveBeenCalledWith('media.purge', expect.anything());
	});
});
