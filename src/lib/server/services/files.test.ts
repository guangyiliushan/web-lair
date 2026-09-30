import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MAX_BATCH_COUNT, MAX_UPLOAD_BYTES } from '$lib/server/media/sniff';
import { files as filesTable, photos as photosTable } from '$lib/server/db/content';
import { fileReferences } from '$lib/server/db/system';
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
const readImageSizeMock = vi.hoisted(() => vi.fn());
const getOptionMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/storage', () => ({ getStorage: () => storageMock }));
vi.mock('$lib/server/media/variants', () => ({
	processImage: processImageMock,
	readImageSize: readImageSizeMock
}));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: getOptionMock }));

import {
	deleteFile,
	isRegisteredKey,
	listPurgeCandidates,
	purgeMedia,
	uploadFile,
	uploadFiles
} from './files';

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
	it('locks the plan §4.2 limits', () => {
		expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
		expect(MAX_BATCH_COUNT).toBe(10);
	});

	it('accepts an upload at exactly the size limit (boundary)', async () => {
		const exact = new Uint8Array(MAX_UPLOAD_BYTES);
		exact.set([0xff, 0xd8, 0xff, 0xe0]);
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce({
			...PROCESSED,
			variants: { ...PROCESSED.variants }
		});
		dbMock.insert.mockReturnValueOnce(
			insertChain([{ ...EXISTING_ROW, width: 64, height: 32, status: 'pending' }])
		);

		const result = await uploadFile(
			{ fileName: 'edge.jpg', bytes: exact },
			{ storage: storageMock }
		);

		expect(result.deduplicated).toBe(false);
	});

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
		const chain = dbMock.select.mock.results[0].value as { from: ReturnType<typeof vi.fn> };
		expect(chain.from.mock.calls[0][0]).toBe(filesTable);
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
		expect(dbMock.insert.mock.calls[0][0]).toBe(filesTable);
	});

	it('uploads the preview variant when the pipeline produced one', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce({
			...PROCESSED,
			variants: { ...PROCESSED.variants, preview: Buffer.from('preview') }
		});
		dbMock.insert.mockReturnValueOnce(
			insertChain([{ ...EXISTING_ROW, width: 64, height: 32, status: 'pending' }])
		);

		await uploadFile({ fileName: 'photo.jpg', bytes: JPEG }, { storage: storageMock });

		expect(storageMock.put.mock.calls.map((call) => call[0])).toEqual([
			BASE_KEY,
			`${BASE_KEY}@thumb`,
			`${BASE_KEY}@preview`,
			`${BASE_KEY}@full`
		]);
	});

	it('stores GIFs as-is without variants (plan §4.3 pass-through)', async () => {
		const GIF = Uint8Array.from('GIF89a', (char) => char.charCodeAt(0));
		const gifHash = createHash('sha256').update(GIF).digest('hex');
		const gifKey = `${gifHash.slice(0, 2)}/${gifHash}.gif`;
		dbMock.select.mockReturnValueOnce(selectChain([]));
		readImageSizeMock.mockResolvedValueOnce({ width: 12, height: 8 });
		dbMock.insert.mockReturnValueOnce(
			insertChain([{ ...EXISTING_ROW, width: 12, height: 8, status: 'pending' }])
		);

		await uploadFile({ fileName: 'fun.gif', bytes: GIF }, { storage: storageMock });

		expect(processImageMock).not.toHaveBeenCalled();
		expect(readImageSizeMock).toHaveBeenCalledWith(GIF);
		expect(storageMock.put.mock.calls.map((call) => call[0])).toEqual([gifKey]);
		const values = dbMock.insert.mock.results[0].value.values.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(values).toMatchObject({ width: 12, height: 8, thumbhash: null });
	});

	it('never writes the registry row when a PUT fails (zero orphans)', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce(PROCESSED);
		storageMock.put.mockRejectedValueOnce(new Error('storage down'));

		await expect(
			uploadFile({ fileName: 'photo.jpg', bytes: JPEG }, { storage: storageMock })
		).rejects.toThrow('storage down');

		expect(dbMock.insert).not.toHaveBeenCalled();
		expect(storageMock.delete).not.toHaveBeenCalled(); // nothing was written
	});

	it('compensates by deleting uploaded objects when the registry write fails', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce(PROCESSED);
		dbMock.insert.mockReturnValueOnce(insertChain(new Error('db exploded')));
		// The compensation re-check runs after the failed insert: no row →
		// this attempt's objects are true orphans and get deleted.
		dbMock.select.mockReturnValueOnce(selectChain([]));

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
		// The winner's objects are content-addressed and SHARED — same-extension
		// attempts touch the same keys, so nothing may be deleted.
		expect(storageMock.delete).not.toHaveBeenCalled();
	});

	it('deletes only extra keys when the winner landed under another extension', async () => {
		const jpegWinner = { ...EXISTING_ROW, objectKey: `${HASH.slice(0, 2)}/${HASH}.jpeg` };
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce(PROCESSED);
		dbMock.insert.mockReturnValueOnce(insertChain(new Error('lost response')));
		dbMock.select.mockReturnValueOnce(selectChain([jpegWinner]));

		const result = await uploadFile(
			{ fileName: 'photo.jpg', bytes: JPEG },
			{ storage: storageMock }
		);

		// Extension is part of the key identity: our `.jpg` keys are NOT shared
		// with the `.jpeg` winner, so all of them are cleaned up.
		expect(result.objectKey).toBe(jpegWinner.objectKey);
		expect(result.deduplicated).toBe(true);
		expect(storageMock.delete.mock.calls.map((call) => call[0])).toEqual([
			BASE_KEY,
			`${BASE_KEY}@thumb`,
			`${BASE_KEY}@full`
		]);
	});

	it('keeps objects when the re-check cannot run (uncertain = do not delete)', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce(PROCESSED);
		dbMock.insert.mockReturnValueOnce(insertChain(new Error('db exploded')));
		dbMock.select.mockImplementationOnce(() => {
			throw new Error('select down');
		});

		await expect(
			uploadFile({ fileName: 'photo.jpg', bytes: JPEG }, { storage: storageMock })
		).rejects.toThrow('db exploded');

		// A re-check that cannot run must not be read as "no winner": shared
		// bytes stay (a stranded object is recoverable, deleted bytes are not).
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

	it('continues past rejected items and still reports successes', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		processImageMock.mockResolvedValueOnce(PROCESSED);
		dbMock.insert.mockReturnValueOnce(
			insertChain([{ ...EXISTING_ROW, width: 64, height: 32, status: 'pending' }])
		);

		const results = await uploadFiles(
			[
				{ fileName: 'payload.exe', bytes: Uint8Array.from([1, 2, 3]) },
				{ fileName: 'ok.jpg', bytes: JPEG }
			],
			{ storage: storageMock }
		);

		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ ok: false, code: 'unsupported-type' });
		expect(results[1]).toMatchObject({ ok: true, file: { deduplicated: false } });
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
			isInGallery: false
		});
		expect(storageMock.delete).not.toHaveBeenCalled();
		// Guard queries must hit the right tables (refs vs photos).
		expect(dbMock.$count.mock.calls[0][0]).toBe(fileReferences);
		expect(dbMock.$count.mock.calls[1][0]).toBe(photosTable);

		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'file-1', objectKey: BASE_KEY }]));
		dbMock.$count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
		expect(await deleteFile('file-1', { storage: storageMock })).toEqual({
			kind: 'referenced',
			refCount: 0,
			isInGallery: true
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
		// Objects-first ordering is retryable: pin it (round-2 mutation m18).
		const lastObjectDelete = storageMock.delete.mock.invocationCallOrder.at(-1) ?? -1;
		expect(lastObjectDelete).toBeGreaterThan(0);
		expect(lastObjectDelete).toBeLessThan(dbMock.delete.mock.invocationCallOrder[0]);
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
		expect(getOptionMock).toHaveBeenCalledWith('media.purge', dbMock);
	});
});

describe('purgeMedia', () => {
	const stalePending = {
		id: 'a',
		objectKey: 'aa/a.jpg',
		fileName: 'a.jpg',
		status: 'pending',
		createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
		detachedAt: null,
		updatedAt: new Date()
	};

	it('dry-run reports candidates but deletes nothing', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([stalePending]));
		// Mention scan: posts / drafts / notes (empty).
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([]));

		const outcome = await purgeMedia({ dryRun: true }, { storage: storageMock });

		expect(outcome.candidates.map((candidate) => candidate.id)).toEqual(['a']);
		expect(outcome.deleted).toEqual([]);
		expect(outcome.skipped).toEqual([]);
		expect(storageMock.delete).not.toHaveBeenCalled();
		expect(dbMock.delete).not.toHaveBeenCalled();
	});

	it('execution deletes the objects and the row (references re-checked)', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([stalePending]));
		// Mention scan: posts / drafts / notes (empty → nothing is skipped).
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'a', objectKey: 'aa/a.jpg' }]));
		dbMock.$count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
		dbMock.delete.mockReturnValueOnce(deleteChain());

		const outcome = await purgeMedia({ dryRun: false }, { storage: storageMock });

		expect(outcome.deleted).toEqual(['aa/a.jpg']);
		expect(storageMock.delete.mock.calls.map((call) => call[0])).toEqual([
			'aa/a.jpg',
			'aa/a.jpg@thumb',
			'aa/a.jpg@preview',
			'aa/a.jpg@full'
		]);
		expect(dbMock.delete).toHaveBeenCalledTimes(1);
	});

	it('skips candidates still mentioned by stored content (execute)', async () => {
		// The mention grammar requires a shasum-shaped key (64 hex chars).
		const sha = 'a'.repeat(64);
		const mentionedKey = `aa/${sha}.jpg`;
		dbMock.select.mockReturnValueOnce(selectChain([{ ...stalePending, objectKey: mentionedKey }]));
		// Mention scan: a draft body carries the candidate's key.
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(
			selectChain([{ id: 'd1', content: `see /i/${mentionedKey} inline` }])
		);
		dbMock.select.mockReturnValueOnce(selectChain([]));

		const outcome = await purgeMedia({ dryRun: false }, { storage: storageMock });

		expect(outcome.skipped).toEqual([mentionedKey]);
		expect(outcome.deleted).toEqual([]);
		expect(storageMock.delete).not.toHaveBeenCalled();
		expect(dbMock.delete).not.toHaveBeenCalled();
	});
});

describe('isRegisteredKey', () => {
	it('answers by object-key lookup on the files table', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'file-1' }]));
		expect(await isRegisteredKey(BASE_KEY, { storage: storageMock })).toBe(true);

		dbMock.select.mockReturnValueOnce(selectChain([]));
		expect(await isRegisteredKey(BASE_KEY, { storage: storageMock })).toBe(false);

		const chain = dbMock.select.mock.results[0].value as { from: ReturnType<typeof vi.fn> };
		expect(chain.from.mock.calls[0][0]).toBe(filesTable);
	});
});
