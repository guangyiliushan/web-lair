import { and, eq, inArray, sql } from 'drizzle-orm';
// Type-only: the module never touches the connection itself (the executor is
// injected), and a value import would keep node scripts from reusing it.
import type { db } from '$lib/server/db';
import { files } from '$lib/server/db/content';
import { fileReferences, type FileRefType } from '$lib/server/db/system';
import { I_KEY_PATTERN } from '$lib/media/keys';

/**
 * Reference maintenance (storage line §4.6; ST-3 3b1). The write side lives
 * in the SAME transaction as the content write (Q15): save / publish /
 * discard (posts + notes, keyed by the draft's target identity) and page
 * hard-delete call `syncFileReferences` with the content's bare `/i/<key>`
 * set. The 'draft' refType value lands with the 3b2 CHECK append; until then
 * the mention scan keeps covering drafts (Q8 clause C).
 *
 * Concurrency contract (review round 1, 2026-10-13):
 * - the resolve SELECT takes `FOR KEY SHARE` on the registry rows, so a
 *   concurrent `deleteFile` (DELETE/FOR UPDATE) waits for this transaction and
 *   the FK INSERT can no longer raise 23503. An in-transaction `catch` would
 *   be a lie anyway: postgres.js aborts the whole transaction on ANY
 *   statement error even when the application caught it (file 3b1 review).
 * - the attach update is unconditional (an already-attached file used to make
 *   it a zero-row no-op that took no lock) and the remove branch locks its
 *   candidates `FOR NO KEY UPDATE` before deciding the detach - together they
 *   serialize concurrent attach vs detach so `status` cannot drift against
 *   the Q6 matrix. The KEY SHARE -> NO KEY UPDATE upgrade inside one
 *   transaction is exempt from self-conflict (heap-layer upgrade), so the
 *   attach update never waits on the resolve above.
 */

/**
 * Transaction-or-db executor (same structural shape as post-drafts).
 *
 * Write paths MUST pass their surrounding transaction: the concurrency
 * guarantees (the FOR KEY SHARE resolve and the status writes below) only
 * hold inside one, and a bare `db` executor would silently lose both the FK
 * protection and the atomicity with the content write.
 */
export type RefsExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Unique bare `/i/<key>` object keys mentioned in stored markdown. */
export function keysFromContent(content: string | null | undefined): string[] {
	if (!content) return [];
	const keys = new Set<string>();
	for (const match of content.matchAll(I_KEY_PATTERN)) keys.add(match[1]);
	return [...keys];
}

/**
 * `keysFromContent` over a per-locale jsonb body map (pages): every locale's
 * markdown is scanned and the key sets union (3b2 backfill; the mention scan
 * flattens the same way).
 */
export function keysFromLocalizedContent(
	content: Record<string, unknown> | null | undefined
): string[] {
	const keys = new Set<string>();
	for (const body of Object.values(content ?? {})) {
		if (typeof body === 'string') {
			for (const key of keysFromContent(body)) keys.add(key);
		}
	}
	return [...keys];
}

/**
 * Differential maintenance of `file_references` for one content target plus
 * the file status machine (Q6 ruling): refs > 0 -> `attached`; == 0 and the
 * row WAS `attached` -> `detached` + a `now()` anchor; `pending` stays
 * `pending`. Desired keys with no registry row are skipped (the file was
 * removed before this save); the skip is warned so a dangling image URL in
 * content stays observable (audit check (2) also surfaces it).
 */
export async function syncFileReferences(
	executor: RefsExecutor,
	ref: { type: FileRefType; id: string },
	keys: string[]
): Promise<void> {
	const desired = new Set(keys);

	const existing = await executor
		.select({ fileId: fileReferences.fileId, objectKey: files.objectKey })
		.from(fileReferences)
		.innerJoin(files, eq(fileReferences.fileId, files.id))
		.where(and(eq(fileReferences.refType, ref.type), eq(fileReferences.refId, ref.id)));
	const existingKeys = new Map(existing.map((row) => [row.objectKey, row.fileId]));

	const removeIds = existing.filter((row) => !desired.has(row.objectKey)).map((row) => row.fileId);
	const addKeys = [...desired].filter((key) => !existingKeys.has(key));

	if (addKeys.length > 0) {
		const resolved = await executor
			.select({ id: files.id, objectKey: files.objectKey })
			.from(files)
			.where(inArray(files.objectKey, addKeys))
			.for('key share');
		const byKey = new Map(resolved.map((row) => [row.objectKey, row.id]));
		const attachedIds: string[] = [];
		let missing = 0;
		for (const key of addKeys) {
			const fileId = byKey.get(key);
			if (!fileId) {
				missing += 1;
				continue;
			}
			await executor
				.insert(fileReferences)
				.values({ fileId, refType: ref.type, refId: ref.id })
				.onConflictDoNothing();
			attachedIds.push(fileId);
		}
		if (attachedIds.length > 0) {
			// Unconditional: locks every row even when it is already attached,
			// which is what serializes this against a concurrent detach.
			await executor
				.update(files)
				.set({ status: 'attached', detachedAt: null })
				.where(inArray(files.id, attachedIds));
		}
		if (missing > 0) {
			// The content mentions a key with no registry row: its URL will 404
			// for readers. Keep it observable without logging the body.
			console.warn('[refs] skipped missing keys', {
				refType: ref.type,
				refId: ref.id,
				missing
			});
		}
	}

	if (removeIds.length > 0) {
		// Lock the candidates first (ordered; the result is deliberately
		// discarded - this SELECT exists for its row locks): an in-flight
		// attach takes the same row lock at its unconditional update, so the
		// remaining-reference snapshot below cannot miss it.
		await executor
			.select({ id: files.id })
			.from(files)
			.where(inArray(files.id, removeIds))
			.orderBy(files.id)
			.for('no key update');
		await executor
			.delete(fileReferences)
			.where(
				and(
					eq(fileReferences.refType, ref.type),
					eq(fileReferences.refId, ref.id),
					inArray(fileReferences.fileId, removeIds)
				)
			);
		// Detach only when the file lost its LAST reference across every
		// target (same image in two posts keeps it attached).
		const remaining = await executor
			.select({ fileId: fileReferences.fileId })
			.from(fileReferences)
			.where(inArray(fileReferences.fileId, removeIds));
		const stillReferenced = new Set(remaining.map((row) => row.fileId));
		const detachIds = removeIds.filter((id) => !stillReferenced.has(id));
		if (detachIds.length > 0) {
			await executor
				.update(files)
				.set({ status: 'detached', detachedAt: sql`now()` })
				.where(and(inArray(files.id, detachIds), eq(files.status, 'attached')));
		}
	}
}

/**
 * Drops every reference a draft wrote under its OWN identity and re-evaluates
 * the status machine for the affected files (ST-3 3b2: draft-phase refs are
 * keyed `{draft, draftId}`; publish/discard delete the draft row and must
 * take its refs with them - a draft-only image flips to `detached` here with
 * the usual clock anchor). Same locking discipline as the remove branch
 * above: candidates are locked ordered `FOR NO KEY UPDATE` first so a
 * concurrent attach cannot race the remaining-reference snapshot.
 */
export async function dropDraftReferences(executor: RefsExecutor, draftId: string): Promise<void> {
	const removed = await executor
		.select({ fileId: fileReferences.fileId })
		.from(fileReferences)
		.where(and(eq(fileReferences.refType, 'draft'), eq(fileReferences.refId, draftId)));
	const fileIds = [...new Set(removed.map((row) => row.fileId))];
	if (fileIds.length === 0) return;
	await executor
		.select({ id: files.id })
		.from(files)
		.where(inArray(files.id, fileIds))
		.orderBy(files.id)
		.for('no key update');
	await executor
		.delete(fileReferences)
		.where(and(eq(fileReferences.refType, 'draft'), eq(fileReferences.refId, draftId)));
	const remaining = await executor
		.select({ fileId: fileReferences.fileId })
		.from(fileReferences)
		.where(inArray(fileReferences.fileId, fileIds));
	const stillReferenced = new Set(remaining.map((row) => row.fileId));
	const detachIds = fileIds.filter((id) => !stillReferenced.has(id));
	if (detachIds.length > 0) {
		await executor
			.update(files)
			.set({ status: 'detached', detachedAt: sql`now()` })
			.where(and(inArray(files.id, detachIds), eq(files.status, 'attached')));
	}
}
