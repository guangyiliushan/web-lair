import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	files as filesTable,
	photoTags as photoTagsTable,
	photos as photosTable,
	tags as tagsTable
} from '$lib/server/db/content';
import { slugTrackers } from '$lib/server/db/system';
import type { StoredObjectBody } from '$lib/server/storage/port';

const dbMock = vi.hoisted(() => {
	const mock = {
		select: vi.fn(),
		selectDistinct: vi.fn(),
		insert: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
		$count: vi.fn(),
		transaction: vi.fn()
	};
	mock.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
		callback({
			select: mock.select,
			insert: mock.insert,
			update: mock.update,
			delete: mock.delete,
			$count: mock.$count
		})
	);
	return mock;
});
const storageMock = vi.hoisted(() => ({
	get: vi.fn(),
	put: vi.fn(),
	delete: vi.fn(),
	head: vi.fn(),
	ensureBucket: vi.fn()
}));
const exifMock = vi.hoisted(() => vi.fn());
const makerNotesMock = vi.hoisted(() =>
	vi.fn(async (): Promise<Record<string, unknown> | null> => null)
);
const getOptionMock = vi.hoisted(() => vi.fn());
const deleteFileMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/storage', () => ({ getStorage: () => storageMock }));
vi.mock('$lib/server/media/exif', () => ({ extractPhotoMetadata: exifMock }));
vi.mock('$lib/server/media/exif-makernotes', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/media/exif-makernotes')>()),
	extractMakerNotes: makerNotesMock
}));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: getOptionMock }));
vi.mock('./files', () => ({ deleteFile: deleteFileMock }));

import {
	createPhotoFromFile,
	listAdminPhotos,
	listPhotoNeighbors,
	photoSlugBase,
	removePhoto,
	updatePhoto
} from './photos';

interface Chain {
	from: () => Chain;
	innerJoin: () => Chain;
	where: () => Chain;
	orderBy: () => Chain;
	groupBy: () => Chain;
	limit: () => Chain;
	then: (
		resolve: (value: unknown[]) => unknown,
		reject?: (e: unknown) => unknown
	) => Promise<unknown>;
}

function selectChain(rows: unknown[]): Chain {
	const chain = {
		from: vi.fn(() => chain),
		innerJoin: vi.fn(() => chain),
		where: vi.fn(() => chain),
		orderBy: vi.fn(() => chain),
		groupBy: vi.fn(() => chain),
		limit: vi.fn(() => chain),
		for: vi.fn(() => chain),
		then: (resolve: (value: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
			Promise.resolve(rows).then(resolve, reject)
	} as unknown as Chain;
	return chain;
}

function insertChain(result?: unknown[] | Error) {
	const chain = {
		values: vi.fn(() => chain),
		returning: vi.fn(async () => {
			if (result instanceof Error) throw result;
			return result;
		}),
		onConflictDoNothing: vi.fn(() => chain),
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			(result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(
				resolve,
				reject
			)
	};
	return chain;
}

function updateChain(result?: unknown[] | Error) {
	const chain = {
		set: vi.fn(() => chain),
		where: vi.fn(() => chain),
		returning: vi.fn(async () => {
			if (result instanceof Error) throw result;
			return result;
		}),
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			(result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(
				resolve,
				reject
			)
	};
	return chain;
}

function deleteChain(result: unknown[] = [{ id: 'gone' }]) {
	const chain = {
		where: vi.fn(() => chain),
		returning: vi.fn(async () => result),
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve(undefined).then(resolve, reject)
	};
	return chain;
}

function bodyFor(bytes: number[]): StoredObjectBody {
	return {
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Uint8Array.from(bytes));
				controller.close();
			}
		}),
		byteSize: bytes.length,
		contentType: 'image/jpeg',
		etag: null
	};
}

const FILE_ROW = {
	id: 'f1',
	objectKey: 'aa/x.jpg',
	fileName: 'Sunset 北京.jpg',
	mimeType: 'image/jpeg'
};
const META = {
	takenAt: new Date('2026-01-02T03:00:00Z'),
	cameraMake: 'FUJIFILM',
	cameraModel: 'X-T5',
	lensModel: 'XF 35mm F1.4 R',
	fNumber: 2.8,
	focalLengthMm: 35,
	exposureTimeS: 0.008,
	iso: 400,
	latitude: 25.033,
	longitude: 121.5654,
	altitudeM: 12.5,
	exif: { ISO: 400, makerNotes: { fuji: { FilmMode: 'Classic Chrome' } } }
};

beforeEach(() => {
	vi.clearAllMocks();
	getOptionMock.mockResolvedValue('UTC');
	exifMock.mockResolvedValue({ ...META });
	makerNotesMock.mockResolvedValue(null);
	storageMock.get.mockResolvedValue(bodyFor([1, 2, 3]));
	deleteFileMock.mockResolvedValue({ kind: 'ok', objectKey: 'aa/x.jpg' });
});

describe('photoSlugBase', () => {
	it('strips the extension, lowercases Latin and keeps CJK', () => {
		expect(photoSlugBase('Sunset 北京.jpg')).toBe('sunset-北京');
		expect(photoSlugBase('IMG_2043.HEIC')).toBe('img-2043');
	});
});

describe('createPhotoFromFile', () => {
	it('returns not-found for unknown files', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		expect(await createPhotoFromFile('missing', {}, { storage: storageMock })).toEqual({
			kind: 'not-found'
		});
	});

	it('rejects non-image files', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ ...FILE_ROW, mimeType: 'application/pdf' }]));
		expect(await createPhotoFromFile('f1', {}, { storage: storageMock })).toEqual({
			kind: 'not-image'
		});
	});

	it('reports the existing photo for a file already in the gallery', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([FILE_ROW]));
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'p9' }]));
		expect(await createPhotoFromFile('f1', {}, { storage: storageMock })).toEqual({
			kind: 'already-in-gallery',
			photoId: 'p9'
		});
		expect(dbMock.transaction).not.toHaveBeenCalled();
	});

	it('creates the photo with EXIF columns and a CJK slug', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([FILE_ROW]));
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([])); // slug check
		dbMock.insert.mockReturnValueOnce(insertChain([{ id: 'p1', slug: 'sunset-北京' }]));

		const result = await createPhotoFromFile('f1', {}, { storage: storageMock });

		expect(result).toEqual({ kind: 'ok', id: 'p1', slug: 'sunset-北京' });
		const values = dbMock.insert.mock.results[0].value.values.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(dbMock.insert.mock.calls[0][0]).toBe(photosTable);
		expect(values).toMatchObject({
			fileId: 'f1',
			slug: 'sunset-北京',
			fNumber: '2.8',
			focalLengthMm: '35',
			exposureTimeS: '0.008',
			iso: 400,
			latitude: '25.033',
			longitude: '121.5654',
			altitudeM: '12.5',
			exif: META.exif
		});
		expect(values.takenAt).toEqual(META.takenAt);
		expect(dbMock.transaction).toHaveBeenCalledTimes(1);
	});

	it('merges the maker-notes dump into the stored exif payload', async () => {
		makerNotesMock.mockResolvedValueOnce({ fuji: { FilmMode: 'Classic Chrome' } });
		dbMock.select.mockReturnValueOnce(selectChain([FILE_ROW]));
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([])); // slug check
		dbMock.insert.mockReturnValueOnce(insertChain([{ id: 'p1', slug: 'x' }]));

		await createPhotoFromFile('f1', {}, { storage: storageMock });

		const values = dbMock.insert.mock.results[0].value.values.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(values.exif).toMatchObject({
			ISO: 400,
			makerNotes: { fuji: { FilmMode: 'Classic Chrome' } }
		});
	});

	it('absorbs a concurrent duplicate insert as already-in-gallery', async () => {
		// T13 race: two directory entries with identical bytes reach the
		// service at once; the loser's insert hits the unique file_id and
		// must map to the winner's row instead of throwing.
		dbMock.select.mockReturnValueOnce(selectChain([FILE_ROW]));
		dbMock.select.mockReturnValueOnce(selectChain([])); // no existing photo yet
		dbMock.select.mockReturnValueOnce(selectChain([])); // slug check
		dbMock.insert.mockReturnValueOnce(
			insertChain(Object.assign(new Error('duplicate key'), { code: '23505' }))
		);
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'p-winner' }])); // winner re-read

		await expect(createPhotoFromFile('f1', {}, { storage: storageMock })).resolves.toEqual({
			kind: 'already-in-gallery',
			photoId: 'p-winner'
		});
	});

	it('backfills missing tags onto an existing photo (CLI directory-tag guarantee)', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([FILE_ROW]));
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'p9', title: null }])); // existing photo
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 't1' }])); // tag lookup hit
		dbMock.insert.mockReturnValueOnce(insertChain(undefined)); // junction row

		await expect(
			createPhotoFromFile('f1', { tags: ['旅行'] }, { storage: storageMock })
		).resolves.toEqual({ kind: 'already-in-gallery', photoId: 'p9' });
		expect(dbMock.insert.mock.calls[0][0]).toBe(photoTagsTable);
		expect(dbMock.insert.mock.results[0].value.values.mock.calls[0][0]).toEqual([
			{ photoId: 'p9', tagId: 't1' }
		]);
	});

	it('retries once with an entropy slug on a slug-only collision', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([FILE_ROW]));
		dbMock.select.mockReturnValueOnce(selectChain([])); // no existing photo
		dbMock.select.mockReturnValueOnce(selectChain([])); // slug check
		dbMock.insert.mockReturnValueOnce(
			insertChain(Object.assign(new Error('duplicate key'), { code: '23505' }))
		);
		dbMock.select.mockReturnValueOnce(selectChain([])); // no winner for the file
		dbMock.insert.mockReturnValueOnce(insertChain([{ id: 'p3', slug: 'sunset-北京-ab12' }]));

		const result = await createPhotoFromFile('f1', {}, { storage: storageMock });

		expect(result).toMatchObject({ kind: 'ok', id: 'p3' });
		expect(dbMock.insert).toHaveBeenCalledTimes(2);
		const retry = dbMock.insert.mock.results[1].value.values.mock.calls[0][0] as {
			slug: string;
		};
		expect(retry.slug.startsWith('sunset-北京-')).toBe(true);
	});

	it('maps a vanished file (23503) to not-found', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([FILE_ROW]));
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([])); // slug check
		dbMock.insert.mockReturnValueOnce(
			insertChain(Object.assign(new Error('fk violation'), { code: '23503' }))
		);

		await expect(createPhotoFromFile('f1', {}, { storage: storageMock })).resolves.toEqual({
			kind: 'not-found'
		});
	});

	it('suffixes a colliding slug', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([FILE_ROW]));
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([{ slug: 'sunset-北京' }]));
		dbMock.insert.mockReturnValueOnce(insertChain([{ id: 'p2', slug: 'sunset-北京-2' }]));

		const result = await createPhotoFromFile('f1', {}, { storage: storageMock });
		expect(result).toMatchObject({ kind: 'ok', slug: 'sunset-北京-2' });
	});

	it('attaches tag names (create-on-demand, junction rows)', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([FILE_ROW]));
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([])); // slug check
		dbMock.select.mockReturnValueOnce(selectChain([])); // tag lookup miss
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 't1' }])); // tag reload
		dbMock.insert.mockReturnValueOnce(insertChain([{ id: 'p1', slug: 'x' }]));
		dbMock.insert.mockReturnValueOnce(insertChain(undefined));
		dbMock.insert.mockReturnValueOnce(insertChain(undefined));

		await createPhotoFromFile('f1', { tags: ['旅行'] }, { storage: storageMock });

		expect(dbMock.insert.mock.calls[1][0]).toBe(tagsTable);
		expect(dbMock.insert.mock.calls[2][0]).toBe(photoTagsTable);
		expect(dbMock.insert.mock.results[2].value.values.mock.calls[0][0]).toEqual([
			{ photoId: 'p1', tagId: 't1' }
		]);
	});
});

describe('updatePhoto', () => {
	it('returns not-found for unknown ids', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		expect(await updatePhoto('missing', { isVisible: false })).toEqual({ kind: 'not-found' });
	});

	it('writes a photo slug tracker in the same transaction as the rename', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'p1', slug: 'old-slug' }]));
		dbMock.update.mockReturnValueOnce(updateChain([{ id: 'p1' }]));
		dbMock.insert.mockReturnValueOnce(insertChain(undefined));

		expect(await updatePhoto('p1', { slug: 'New Slug' })).toEqual({ kind: 'ok' });
		expect(dbMock.insert.mock.calls[0][0]).toBe(slugTrackers);
		expect(dbMock.insert.mock.results[0].value.values.mock.calls[0][0]).toEqual({
			slug: 'old-slug',
			type: 'photo',
			lang: 'en',
			targetId: 'p1'
		});
		expect(dbMock.transaction).toHaveBeenCalledTimes(1);
	});

	it('rejects an empty normalized slug', async () => {
		// Slug validation happens before the transaction — no select consumed.
		expect(await updatePhoto('p1', { slug: '!!!' })).toEqual({ kind: 'slug-invalid' });
	});

	it('maps a unique violation to slug-taken (production error shape)', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'p1', slug: 'x' }]));
		const duplicate = Object.assign(new Error('duplicate key'), { cause: { code: '23505' } });
		dbMock.update.mockReturnValueOnce(updateChain(duplicate));

		expect(await updatePhoto('p1', { slug: 'taken' })).toEqual({ kind: 'slug-taken' });
	});

	it('replaces the tag set when tags are provided', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'p1', slug: 'x' }]));
		dbMock.update.mockReturnValueOnce(updateChain([{ id: 'p1' }]));
		dbMock.delete.mockReturnValueOnce(deleteChain());
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 't1' }])); // tag lookup hit
		dbMock.insert.mockReturnValueOnce(insertChain(undefined)); // junction

		expect(await updatePhoto('p1', { tags: ['旅行'] })).toEqual({ kind: 'ok' });
		expect(dbMock.delete.mock.calls[0][0]).toBe(photoTagsTable);
		expect(dbMock.insert.mock.calls[0][0]).toBe(photoTagsTable);
	});
});

describe('removePhoto', () => {
	it('returns not-found when the photo row is gone', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		expect(await removePhoto('missing')).toEqual({ kind: 'not-found' });
	});

	it('removes the photo row and keeps the file by default', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'p1', fileId: 'f1' }]));
		dbMock.delete.mockReturnValueOnce(deleteChain([])); // slug trackers
		dbMock.delete.mockReturnValueOnce(deleteChain([{ id: 'p1' }])); // photo row

		expect(await removePhoto('p1')).toEqual({
			kind: 'ok',
			fileDeleted: false,
			fileBlocked: false
		});
		expect(dbMock.delete.mock.calls[0][0]).toBe(slugTrackers);
		expect(deleteFileMock).not.toHaveBeenCalled();
	});

	it('re-runs the file guard when removeFile is asked for', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ id: 'p1', fileId: 'f1' }]));
		dbMock.delete.mockReturnValueOnce(deleteChain([])); // slug trackers
		dbMock.delete.mockReturnValueOnce(deleteChain([{ id: 'p1' }])); // photo row
		deleteFileMock.mockResolvedValueOnce({ kind: 'referenced', refCount: 2, isInGallery: false });

		expect(await removePhoto('p1', { removeFile: true })).toEqual({
			kind: 'ok',
			fileDeleted: false,
			fileBlocked: true
		});
		expect(deleteFileMock).toHaveBeenCalledTimes(1);
		expect(deleteFileMock.mock.calls[0][0]).toBe('f1');
	});
});

describe('listAdminPhotos', () => {
	it('joins files, attaches tags and keeps the ref count', async () => {
		dbMock.select.mockReturnValueOnce(
			selectChain([
				{
					id: 'p1',
					slug: 'x',
					title: null,
					description: null,
					takenAt: null,
					isVisible: true,
					createdAt: new Date(),
					fileId: 'f1',
					objectKey: 'aa/x.jpg',
					fileName: 'x.jpg',
					mimeType: 'image/jpeg',
					byteSize: 3,
					width: 10,
					height: 10,
					thumbhash: 'TH',
					palette: null,
					refCount: 2
				}
			])
		);
		dbMock.select.mockReturnValueOnce(
			selectChain([{ photoId: 'p1', id: 't1', name: '旅行', slug: '旅行' }])
		);

		const rows = await listAdminPhotos();
		expect(rows).toHaveLength(1);
		expect(rows[0].tags).toEqual([{ id: 't1', name: '旅行', slug: '旅行' }]);
		const chain = dbMock.select.mock.results[0].value as {
			from: ReturnType<typeof vi.fn>;
			innerJoin: ReturnType<typeof vi.fn>;
		};
		expect(chain.from.mock.calls[0][0]).toBe(photosTable);
		expect(chain.innerJoin.mock.calls[0][0]).toBe(filesTable);
	});
});

describe('listPhotoNeighbors', () => {
	it('returns the adjacent visible rows around the cursor', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([{ slug: 'newer', title: { en: 'N' } }]));
		dbMock.select.mockReturnValueOnce(selectChain([{ slug: 'older', title: null }]));

		const result = await listPhotoNeighbors({
			sortAt: new Date('2026-01-01T00:00:00Z'),
			id: '11111111-1111-1111-1111-111111111111'
		});

		expect(result).toEqual({
			newer: { slug: 'newer', title: { en: 'N' } },
			older: { slug: 'older', title: null }
		});
		expect(dbMock.select).toHaveBeenCalledTimes(2);
	});

	it('returns null neighbours at the feed boundaries', async () => {
		dbMock.select.mockReturnValueOnce(selectChain([]));
		dbMock.select.mockReturnValueOnce(selectChain([]));

		await expect(
			listPhotoNeighbors({
				sortAt: new Date('2026-01-01T00:00:00Z'),
				id: '11111111-1111-1111-1111-111111111111'
			})
		).resolves.toEqual({ newer: null, older: null });
	});
});
