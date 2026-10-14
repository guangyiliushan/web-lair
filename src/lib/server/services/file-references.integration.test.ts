import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '$lib/server/db/schema';
import { dropDraftReferences, syncFileReferences } from './file-references';

/**
 * Service-level reference lifecycle on a REAL scratch database (ST-3 3b2;
 * register: "two-connection integration teeth - run the window on a scratch
 * container"). Skipped unless REFS_SCRATCH_URL points at a migrated scratch
 * database (baseline + the 3b2 append apply), so the default suite stays
 * offline. Drives the real `syncFileReferences` / `dropDraftReferences`
 * wiring across separate connections: draft-identity writes, publish
 * re-keying, the detach with a `now()` anchor, and the attach-vs-detach
 * interleavings the locking discipline exists for.
 */
const url = process.env.REFS_SCRATCH_URL;
const K1 = `55/55${'a'.repeat(62)}.png`;
const K2 = `55/55${'b'.repeat(62)}.png`;
const K3 = `55/55${'c'.repeat(62)}.png`;
const K4 = `55/55${'d'.repeat(62)}.png`;

describe.skipIf(!url)('reference lifecycle on a scratch database (3b2)', () => {
	const sqlA = postgres(url!, { max: 2 });
	const sqlB = postgres(url!, { max: 2 });
	const dbA = drizzle(sqlA, { schema });
	const dbB = drizzle(sqlB, { schema });

	async function cleanup() {
		await sqlA`delete from file_references where file_id in (select id from files where file_name like 'refs-integ-%')`;
		await sqlA`delete from files where file_name like 'refs-integ-%'`;
	}
	async function seedFiles(keys: string[]) {
		for (const key of keys) {
			await sqlA`insert into files (object_key, content_hash, file_name, mime_type, byte_size, status)
				values (${key}, ${'hash-' + key}, ${'refs-integ-' + key.slice(-8) + '.png'}, 'image/png', 10, 'pending')`;
		}
	}
	async function fileState(key: string) {
		const [row] = await sqlA<{ status: string; anchored: boolean }[]>`
			select status, (detached_at is not null) as anchored from files where object_key = ${key}`;
		return row;
	}
	async function refsFor(fileKey: string) {
		const rows = await sqlA<{ ref_type: string; ref_id: string }[]>`
			select fr.ref_type, fr.ref_id from file_references fr
			join files f on f.id = fr.file_id where f.object_key = ${fileKey} order by fr.ref_type, fr.ref_id`;
		return rows.map((row) => `${row.ref_type}:${row.ref_id.slice(0, 8)}`);
	}

	beforeAll(async () => {
		await cleanup();
		await seedFiles([K1, K2, K3, K4]);
	});
	afterAll(async () => {
		await cleanup();
		await sqlA.end();
		await sqlB.end();
	});

	it('draft save keys on the draft identity; publish re-keys and drops the draft refs', async () => {
		await syncFileReferences(dbA, { type: 'draft', id: 'd1000000-0000-4000-8000-000000000001' }, [
			K1
		]);
		expect(await refsFor(K1)).toEqual(['draft:d1000000']);
		expect((await fileState(K1))?.status).toBe('attached');

		await syncFileReferences(dbA, { type: 'post', id: 'a1000000-0000-4000-8000-000000000001' }, [
			K1
		]);
		await dropDraftReferences(dbA, 'd1000000-0000-4000-8000-000000000001');
		expect(await refsFor(K1)).toEqual(['post:a1000000']);
		expect((await fileState(K1))?.status).toBe('attached');
	});

	it('discarding the last draft-only reference detaches with a now() anchor', async () => {
		await syncFileReferences(dbA, { type: 'draft', id: 'd2000000-0000-4000-8000-000000000002' }, [
			K2
		]);
		await dropDraftReferences(dbA, 'd2000000-0000-4000-8000-000000000002');
		expect(await refsFor(K2)).toEqual([]);
		const state = await fileState(K2);
		expect(state?.status).toBe('detached');
		expect(state?.anchored).toBe(true);
	});

	it('a shared file stays attached while any reference remains', async () => {
		await syncFileReferences(dbA, { type: 'draft', id: 'd3000000-0000-4000-8000-000000000003' }, [
			K1
		]);
		await dropDraftReferences(dbA, 'd3000000-0000-4000-8000-000000000003');
		expect(await refsFor(K1)).toEqual(['post:a1000000']);
		expect((await fileState(K1))?.status).toBe('attached');
	});

	it('interleaved attach vs detach on two connections converge (attach then remove)', async () => {
		await syncFileReferences(dbA, { type: 'draft', id: 'd4000000-0000-4000-8000-000000000004' }, [
			K3
		]);
		await Promise.all([
			dbA.transaction(async (tx) =>
				syncFileReferences(tx, { type: 'draft', id: 'd5000000-0000-4000-8000-000000000005' }, [K3])
			),
			dbB.transaction(async (tx) => dropDraftReferences(tx, 'd4000000-0000-4000-8000-000000000004'))
		]);
		expect(await refsFor(K3)).toEqual(['draft:d5000000']);
		expect((await fileState(K3))?.status).toBe('attached');
	});

	it('interleaved detach vs attach cannot lose the surviving reference', async () => {
		await syncFileReferences(dbA, { type: 'draft', id: 'd6000000-0000-4000-8000-000000000006' }, [
			K4
		]);
		await Promise.all([
			dbB.transaction(async (tx) =>
				dropDraftReferences(tx, 'd6000000-0000-4000-8000-000000000006')
			),
			dbA.transaction(async (tx) =>
				syncFileReferences(tx, { type: 'draft', id: 'd7000000-0000-4000-8000-000000000007' }, [K4])
			)
		]);
		// Either serialization order lands here: the surviving draft ref
		// survives and the file is attached (a lost reference would leave the
		// file detached or drop d7000000 - the locking discipline forbids it).
		expect(await refsFor(K4)).toEqual(['draft:d7000000']);
		expect((await fileState(K4))?.status).toBe('attached');
	});
});
