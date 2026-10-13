import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { files } from '$lib/server/db/content';
import { fileReferences, type FileRefType } from '$lib/server/db/system';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { I_KEY_PATTERN } from '$lib/media/keys';

/**
 * Reference maintenance (storage line §4.6; ST-3 3b1). The write side lives
 * in the SAME transaction as the content write (Q15): save / publish /
 * discard (posts + notes, keyed by the draft's target identity) and page
 * hard-delete call `syncFileReferences` with the content's bare `/i/<key>`
 * set. The 'draft' refType value lands with the 3b2 CHECK append; until then
 * the mention scan keeps covering drafts (Q8 clause C).
 */

/** Transaction-or-db executor (same structural shape as post-drafts). */
export type RefsExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ReferenceSyncSummary {
	added: number;
	removed: number;
	/** Desired keys with no registry row (removed concurrently) - skipped. */
	missing: number;
	attached: number;
	detached: number;
}

/** Unique bare `/i/<key>` object keys mentioned in stored markdown. */
export function keysFromContent(content: string | null | undefined): string[] {
	if (!content) return [];
	const keys = new Set<string>();
	for (const match of content.matchAll(I_KEY_PATTERN)) keys.add(match[1]);
	return [...keys];
}

/**
 * Differential maintenance of `file_references` for one content target plus
 * the file status machine (Q6 ruling): refs > 0 -> `attached`; == 0 and the
 * row WAS `attached` -> `detached` + anchor; `pending` stays `pending`.
 * Files whose registry row died concurrently are skipped (the ST-3 write-side
 * "23503 = file already removed" contract; audit check (2) still surfaces the
 * dangling key in content).
 */
export async function syncFileReferences(
	executor: RefsExecutor,
	ref: { type: FileRefType; id: string },
	keys: string[]
): Promise<ReferenceSyncSummary> {
	const summary: ReferenceSyncSummary = {
		added: 0,
		removed: 0,
		missing: 0,
		attached: 0,
		detached: 0
	};
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
			.where(inArray(files.objectKey, addKeys));
		const byKey = new Map(resolved.map((row) => [row.objectKey, row.id]));
		const attachedIds: string[] = [];
		for (const key of addKeys) {
			const fileId = byKey.get(key);
			if (!fileId) {
				summary.missing += 1;
				continue;
			}
			try {
				await executor
					.insert(fileReferences)
					.values({ fileId, refType: ref.type, refId: ref.id })
					.onConflictDoNothing();
			} catch (caught) {
				if (pgErrorCode(caught) === '23503') {
					summary.missing += 1;
					continue;
				}
				throw caught;
			}
			attachedIds.push(fileId);
		}
		if (attachedIds.length > 0) {
			await executor
				.update(files)
				.set({ status: 'attached', detachedAt: null })
				.where(and(inArray(files.id, attachedIds), ne(files.status, 'attached')));
			summary.added = attachedIds.length;
			summary.attached = attachedIds.length;
		}
	}

	if (removeIds.length > 0) {
		await executor
			.delete(fileReferences)
			.where(
				and(
					eq(fileReferences.refType, ref.type),
					eq(fileReferences.refId, ref.id),
					inArray(fileReferences.fileId, removeIds)
				)
			);
		summary.removed = removeIds.length;
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
				.set({ status: 'detached', detachedAt: new Date() })
				.where(and(inArray(files.id, detachIds), eq(files.status, 'attached')));
			summary.detached = detachIds.length;
		}
	}

	return summary;
}
