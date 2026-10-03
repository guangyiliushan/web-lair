import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { drafts, notes } from '$lib/server/db/content';
import { slugTrackers } from '$lib/server/db/system';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isReservedNoteSlug, NOTE_EMOTIONS, NOTE_MOODS } from '$lib/utils/note-meta';
import { hashNotePassword } from './note-gate';
import { DRAFT_THROTTLE_MS } from './post-drafts';

/**
 * Draft-flow service for notes (N1 admin; ledger §9.10 / §13.4, notes plan
 * v0.4 §2.3): mirrors post-drafts - the editor writes one `drafts` row per
 * target and the publish transaction copies it onto `notes`. Publish
 * parameters (`status` / `published_at` / `pin_at` / `password_hash` /
 * `allow_comment`) never travel through drafts; they are row-level actions
 * below (§2.3 contract). Notes have no row version counter, so the publish
 * base check relies on the one-draft-per-note unique + row locks + the
 * draft's own optimistic version (documented N1 decision).
 */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Marker for the auto-generated slug of never-published placeholder rows. */
const PLACEHOLDER_SLUG_PREFIX = 'draft-';

export function isNotePlaceholderSlug(slug: string): boolean {
	return slug.startsWith(PLACEHOLDER_SLUG_PREFIX);
}

/** Unique-enough placeholder slug; the real slug is required at publish. */
export function noteTempSlug(): string {
	return `${PLACEHOLDER_SLUG_PREFIX}${randomBytes(5).toString('hex')}`;
}

export interface NoteDraftPayload {
	title: string;
	slug: string;
	/** Topic is OPTIONAL (unlike the posts category precondition). */
	topicId: string;
	mood: string;
	weatherCode: string | number | null;
	temperatureC: string | null;
	latitude: string;
	longitude: string;
	location: string;
	content: string;
}

interface NormalizedNoteDraft {
	title: string;
	slug: string;
	topicId: string;
	mood: string;
	weatherCode: number | null;
	temperatureC: string | null;
	coordinates: { latitude: number; longitude: number } | null;
	location: string;
	content: string;
}

/** Coerce a weather code; anything outside the DB CHECK range becomes null. */
function normalizeWeatherCode(raw: string | number | null): number | null {
	if (raw === null || raw === '') return null;
	const value = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 0 || value > 99) return null;
	return value;
}

/** Numeric column; keep the form string but drop garbage (CHECK backs range). */
function normalizeTemperature(raw: string | null): string | null {
	if (raw === null) return null;
	const trimmed = raw.trim();
	if (trimmed === '') return null;
	const value = Number.parseFloat(trimmed);
	if (!Number.isFinite(value) || value < -99.9 || value > 99.9) return null;
	return trimmed;
}

/** Both coordinates or neither; out-of-range values drop the pair. */
function normalizeCoordinates(
	latRaw: string,
	lngRaw: string
): { latitude: number; longitude: number } | null {
	const lat = latRaw.trim();
	const lng = lngRaw.trim();
	if (lat === '' || lng === '') return null;
	const latitude = Number.parseFloat(lat);
	const longitude = Number.parseFloat(lng);
	if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
	if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
	return { latitude, longitude };
}

function normalizeNotePayload(payload: NoteDraftPayload): NormalizedNoteDraft {
	const mood = (payload.mood ?? '').trim();
	return {
		title: payload.title ?? '',
		slug: (payload.slug ?? '').trim(),
		topicId: (payload.topicId ?? '').trim(),
		// Closed vocabulary (notes plan §8.1): values outside the five
		// DB-backed levels are dropped to null (the route answers 400 first).
		mood: (NOTE_MOODS as readonly string[]).includes(mood) ? mood : '',
		weatherCode: normalizeWeatherCode(payload.weatherCode ?? null),
		temperatureC: normalizeTemperature(payload.temperatureC ?? null),
		coordinates: normalizeCoordinates(payload.latitude ?? '', payload.longitude ?? ''),
		location: (payload.location ?? '').trim(),
		content: payload.content ?? ''
	};
}

/**
 * Hash the exact write set (single source of truth): any change that
 * `noteDraftUpdateSet` persists is part of the hash by construction.
 */
function noteDraftUpdateSet(payload: NormalizedNoteDraft) {
	return {
		title: payload.title,
		slug: payload.slug === '' ? null : payload.slug,
		topicId: payload.topicId === '' ? null : payload.topicId,
		mood: payload.mood === '' ? null : payload.mood,
		weatherCode: payload.weatherCode,
		temperatureC: payload.temperatureC,
		coordinates: payload.coordinates,
		location: payload.location === '' ? null : payload.location,
		content: payload.content,
		contentFormat: 'markdown'
	};
}

/** The "hash 不变不写" comparison basis (§9.10) - payload vs stored row. */
export function noteDraftHash(payload: NoteDraftPayload): string {
	return hashNormalized(normalizeNotePayload(payload));
}

function hashNormalized(value: NormalizedNoteDraft): string {
	return createHash('sha256')
		.update(JSON.stringify(noteDraftUpdateSet(value)))
		.digest('hex');
}

type NoteDraftRow = typeof drafts.$inferSelect;

function hashRow(row: NoteDraftRow): string {
	return hashNormalized({
		title: row.title,
		slug: row.slug ?? '',
		topicId: row.topicId ?? '',
		mood: row.mood ?? '',
		weatherCode: row.weatherCode,
		temperatureC: row.temperatureC,
		coordinates: row.coordinates,
		location: row.location ?? '',
		content: row.content ?? ''
	});
}

export async function loadNoteDraftById(draftId: string): Promise<NoteDraftRow | null> {
	const [row] = await db
		.select()
		.from(drafts)
		.where(and(eq(drafts.id, draftId), eq(drafts.refType, 'note')))
		.limit(1);
	return row ?? null;
}

export async function loadNoteDraftByNoteId(noteId: string): Promise<NoteDraftRow | null> {
	const [row] = await db
		.select()
		.from(drafts)
		.where(and(eq(drafts.refType, 'note'), eq(drafts.refId, noteId)))
		.limit(1);
	return row ?? null;
}

/* ── Save (autosave + manual share one path) ─────────────────────────── */

export type SaveNoteDraftResult =
	| { kind: 'saved'; draftId: string; version: number; noteId: string; updatedAt: Date | null }
	| { kind: 'unchanged'; draftId: string; version: number; noteId: string }
	| { kind: 'throttled'; draftId: string; version: number; noteId: string; retryAfterMs: number }
	| {
			kind: 'conflict';
			server: { draftId: string | null; version: number; updatedAt: Date | null };
	  }
	| { kind: 'not-found' };

export interface SaveNoteDraftInput {
	/** Draft row address (preferred once the client has one). */
	draftId?: string | null;
	/** Notes id (existing note, or absent for a brand-new note). */
	noteId?: string | null;
	/** Draft version the client last saw (optimistic lock, §9.10). */
	expectedVersion?: number | null;
	/** Language for a brand-new note (picker; the placeholder row stores it). */
	lang?: string | null;
	payload: NoteDraftPayload;
	author?: string | null;
	/** Autosave skips the 30s server throttle; manual saves always go through. */
	autosave: boolean;
}

export async function saveNoteDraftWork(input: SaveNoteDraftInput): Promise<SaveNoteDraftResult> {
	const payload = normalizeNotePayload(input.payload);

	// Address by draft row first (covers both new placeholders and edits).
	if (input.draftId) {
		const draft = await loadNoteDraftById(input.draftId);
		if (!draft) {
			// The row is gone: it was published or discarded elsewhere.
			return { kind: 'conflict', server: { draftId: null, version: 0, updatedAt: null } };
		}
		return updateExistingNoteDraft(draft, payload, input);
	}

	if (input.noteId) {
		const existing = await loadNoteDraftByNoteId(input.noteId);
		if (existing) return updateExistingNoteDraft(existing, payload, input);

		const [note] = await db
			.select({ id: notes.id })
			.from(notes)
			.where(eq(notes.id, input.noteId))
			.limit(1);
		if (!note) return { kind: 'not-found' };
		try {
			const [created] = await db
				.insert(drafts)
				.values({
					refType: 'note',
					refId: note.id,
					...noteDraftUpdateSet(payload),
					version: 1,
					// Notes have no row version counter: the draft's own
					// optimistic version plus the one-draft-per-note unique
					// cover every documented conflict scenario (N1 decision).
					baseVersion: null,
					author: input.author ?? null,
					updatedAt: new Date()
				})
				.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });
			return {
				kind: 'saved',
				draftId: created.id,
				version: created.version,
				noteId: note.id,
				updatedAt: created.updatedAt
			};
		} catch (caught) {
			// A concurrent tab created the draft first - surface it as a conflict.
			if (pgErrorCode(caught) === '23505') {
				const server = await loadNoteDraftByNoteId(input.noteId);
				return {
					kind: 'conflict',
					server: {
						draftId: server?.id ?? null,
						version: server?.version ?? 0,
						updatedAt: server?.updatedAt ?? null
					}
				};
			}
			throw caught;
		}
	}

	// Brand-new note: NO precondition (unlike posts' needs-category) - the
	// first save materializes the placeholder notes row (§9.10 auto-draft
	// style; the topic stays optional until publish validation).
	const lang = input.lang ?? 'en';
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const result = await db.transaction(async (tx) => {
				const [createdNote] = await tx
					.insert(notes)
					.values({
						title: payload.title,
						slug: noteTempSlug(),
						lang,
						status: 'draft',
						contentFormat: 'markdown',
						// notes.updated_at has no DB default (same application-level
						// pattern as posts, ledger §9.7).
						updatedAt: new Date()
					})
					.returning({ id: notes.id });
				const [createdDraft] = await tx
					.insert(drafts)
					.values({
						refType: 'note',
						refId: createdNote.id,
						...noteDraftUpdateSet(payload),
						version: 1,
						baseVersion: null,
						author: input.author ?? null,
						updatedAt: new Date()
					})
					.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });
				return { noteId: createdNote.id, draft: createdDraft };
			});
			return {
				kind: 'saved',
				draftId: result.draft.id,
				version: result.draft.version,
				noteId: result.noteId,
				updatedAt: result.draft.updatedAt
			};
		} catch (caught) {
			// Placeholder slug collision (extremely unlikely): retry with a new one.
			if (pgErrorCode(caught) === '23505' && attempt < 2) continue;
			throw caught;
		}
	}
	throw new Error('note draft placeholder creation failed');
}

async function updateExistingNoteDraft(
	draft: NoteDraftRow,
	payload: NormalizedNoteDraft,
	input: SaveNoteDraftInput
): Promise<SaveNoteDraftResult> {
	const noteId = draft.refId ?? '';

	// "hash 不变不写" - identical payloads never bump the version.
	if (hashRow(draft) === hashNormalized(payload)) {
		return { kind: 'unchanged', draftId: draft.id, version: draft.version, noteId };
	}

	// Autosave throttle: at most one write per draft per 30s (§9.10). Manual
	// saves bypass it; the client retries from the `retryAfterMs` hint.
	const lastWrite = draft.updatedAt?.getTime() ?? 0;
	const elapsed = Date.now() - lastWrite;
	if (input.autosave && elapsed < DRAFT_THROTTLE_MS) {
		return {
			kind: 'throttled',
			draftId: draft.id,
			version: draft.version,
			noteId,
			retryAfterMs: DRAFT_THROTTLE_MS - elapsed
		};
	}

	// Optimistic lock: the client's base version must still be current.
	if (input.expectedVersion != null && draft.version !== input.expectedVersion) {
		return {
			kind: 'conflict',
			server: { draftId: draft.id, version: draft.version, updatedAt: draft.updatedAt }
		};
	}

	const expected = input.expectedVersion ?? draft.version;
	const updated = await db
		.update(drafts)
		.set({ ...noteDraftUpdateSet(payload), version: draft.version + 1, updatedAt: new Date() })
		.where(and(eq(drafts.id, draft.id), eq(drafts.version, expected)))
		.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });

	if (updated.length === 0) {
		// Lost the conditional update to a concurrent save.
		const server = await loadNoteDraftById(draft.id);
		return {
			kind: 'conflict',
			server: {
				draftId: server?.id ?? null,
				version: server?.version ?? 0,
				updatedAt: server?.updatedAt ?? null
			}
		};
	}

	return {
		kind: 'saved',
		draftId: updated[0].id,
		version: updated[0].version,
		noteId,
		updatedAt: updated[0].updatedAt
	};
}

/* ── Publish transaction (§9.2 / §9.12 / §9.10) ──────────────────────── */

export type PublishNoteResult =
	| { kind: 'published'; noteId: string }
	| { kind: 'not-found' }
	| { kind: 'invalid'; errors: Record<string, string> }
	| { kind: 'slug-taken' }
	| { kind: 'busy' };

/** Note slugs keep CJK on purpose (titleSlug rule, notes plan §8.3). */
const NOTE_SLUG_RE = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

export async function publishNoteDraft(draftId: string): Promise<PublishNoteResult> {
	const draft = await loadNoteDraftById(draftId);
	if (!draft || !draft.refId) return { kind: 'not-found' };

	const [note] = await db.select().from(notes).where(eq(notes.id, draft.refId)).limit(1);
	if (!note) return { kind: 'not-found' };

	const errors: Record<string, string> = {};
	const title = draft.title.trim();
	const slug = (draft.slug ?? '').trim();
	const mood = (draft.mood ?? '').trim();
	if (!title) errors.title = '标题不能为空';
	if (!slug) errors.slug = 'Slug 不能为空';
	else if (!NOTE_SLUG_RE.test(slug)) errors.slug = 'Slug 仅允许字母、数字、汉字与连字符';
	else if (slug !== slug.toLowerCase()) errors.slug = 'Slug 需为小写';
	else if (isReservedNoteSlug(slug)) errors.slug = '该 Slug 为保留词，请更换';
	else if (isNotePlaceholderSlug(slug)) errors.slug = '该 Slug 前缀由系统占位保留，请更换';
	if (!(draft.content ?? '').trim()) errors.content = '正文不能为空';
	if (mood && !(NOTE_MOODS as readonly string[]).includes(mood)) errors.mood = '心情取值无效';
	if (Object.keys(errors).length > 0) return { kind: 'invalid', errors };

	try {
		return await db.transaction(async (tx) => {
			// Lock order notes → drafts (same order as discardNoteDraft) so a
			// publish and a discard on the same target cannot deadlock, and
			// publish the LOCKED draft: a concurrent save landing between the
			// snapshot and this transaction must not be silently lost.
			const [locked] = await tx
				.select()
				.from(notes)
				.where(eq(notes.id, note.id))
				.limit(1)
				.for('update');
			if (!locked) return { kind: 'not-found' as const };

			const [lockedDraft] = await tx
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, draft.id), eq(drafts.refType, 'note')))
				.limit(1)
				.for('update');
			if (!lockedDraft) return { kind: 'not-found' as const };

			const finalTitle = lockedDraft.title.trim();
			const finalSlug = (lockedDraft.slug ?? '').trim();
			if (!finalTitle || !finalSlug || !(lockedDraft.content ?? '').trim()) {
				return {
					kind: 'invalid' as const,
					errors: { form: '草稿内容已变化，请刷新后重试' } as Record<string, string>
				};
			}
			if (
				!NOTE_SLUG_RE.test(finalSlug) ||
				finalSlug !== finalSlug.toLowerCase() ||
				isReservedNoteSlug(finalSlug) ||
				isNotePlaceholderSlug(finalSlug)
			) {
				return {
					kind: 'invalid' as const,
					errors: { slug: 'Slug 格式无效' } as Record<string, string>
				};
			}

			// Slug change: keep the old slug resolvable (single-hop 301 via
			// slug_trackers, P3-b resolver contract).
			if (locked.slug !== finalSlug && !isNotePlaceholderSlug(locked.slug)) {
				await tx.insert(slugTrackers).values({
					slug: locked.slug,
					type: 'note',
					lang: locked.lang,
					targetId: locked.id
				});
			}

			await tx
				.update(notes)
				.set({
					title: finalTitle,
					slug: finalSlug,
					topicId: lockedDraft.topicId ?? null,
					mood: lockedDraft.mood ?? null,
					weatherCode: lockedDraft.weatherCode,
					temperatureC: lockedDraft.temperatureC,
					coordinates: lockedDraft.coordinates,
					location: lockedDraft.location,
					content: lockedDraft.content,
					contentFormat: lockedDraft.contentFormat,
					status: 'published',
					publishedAt: sql`coalesce(${notes.publishedAt}, now())`,
					updatedAt: new Date()
				})
				.where(eq(notes.id, locked.id));

			await tx.delete(drafts).where(eq(drafts.id, lockedDraft.id));

			return { kind: 'published' as const, noteId: locked.id };
		});
	} catch (caught) {
		const code = pgErrorCode(caught);
		if (code === '23505') return { kind: 'slug-taken' };
		if (code === '23503') return { kind: 'invalid', errors: { topicId: '专栏不存在' } };
		// Deadlock/serialization failures are retryable admin-action conflicts.
		if (code === '40P01' || code === '40001') return { kind: 'busy' };
		throw caught;
	}
}

/* ── Discard (§9.14.3 analogue) ──────────────────────────────────────── */

export type DiscardNoteResult =
	| { kind: 'discarded'; noteId: string | null; removedPlaceholder: boolean }
	| { kind: 'not-found' }
	| { kind: 'busy' };

export async function discardNoteDraft(draftId: string): Promise<DiscardNoteResult> {
	try {
		return await db.transaction(async (tx) => {
			const [draft] = await tx
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, draftId), eq(drafts.refType, 'note')))
				.limit(1);
			if (!draft) return { kind: 'not-found' as const };

			if (draft.refId) {
				// Lock order matches publishNoteDraft (notes → drafts).
				const [note] = await tx
					.select({ id: notes.id, status: notes.status, publishedAt: notes.publishedAt })
					.from(notes)
					.where(eq(notes.id, draft.refId))
					.limit(1)
					.for('update');
				const deleted = await tx
					.delete(drafts)
					.where(eq(drafts.id, draft.id))
					.returning({ id: drafts.id });
				// The draft vanished under us (published concurrently).
				if (deleted.length === 0) return { kind: 'not-found' as const };
				let removedPlaceholder = false;
				// A never-published note goes with its draft: notes have no
				// version counter, so "never published" = no publishedAt AND
				// still in the draft status (N1 decision).
				if (note && note.publishedAt == null && note.status === 'draft') {
					await tx.delete(notes).where(eq(notes.id, note.id));
					removedPlaceholder = true;
				}
				return { kind: 'discarded' as const, noteId: draft.refId, removedPlaceholder };
			}

			const deleted = await tx
				.delete(drafts)
				.where(eq(drafts.id, draft.id))
				.returning({ id: drafts.id });
			if (deleted.length === 0) return { kind: 'not-found' as const };
			return { kind: 'discarded' as const, noteId: null, removedPlaceholder: false };
		});
	} catch (caught) {
		const code = pgErrorCode(caught);
		if (code === '40P01' || code === '40001') return { kind: 'busy' };
		throw caught;
	}
}

/* ── Row-level settings (§2.3: never staged in drafts) ───────────────── */

export type NoteRowActionResult =
	{ kind: 'ok' } | { kind: 'not-found' } | { kind: 'invalid'; message: string };

/**
 * Status actions: 转 private / 入 trash / trash 恢复. Restore returns the
 * row to `published` when it had been public before (publishedAt is the only
 * durable trace of "was public"), otherwise to `draft` - notes keep no
 * status history (N1 decision).
 */
export async function setNoteStatus(
	noteId: string,
	action: 'private' | 'trash' | 'restore'
): Promise<NoteRowActionResult> {
	const [note] = await db
		.select({ id: notes.id, status: notes.status, publishedAt: notes.publishedAt })
		.from(notes)
		.where(eq(notes.id, noteId))
		.limit(1);
	if (!note) return { kind: 'not-found' };
	if (note.status === actionToStatus(action, note.publishedAt)) return { kind: 'ok' };

	await db
		.update(notes)
		.set({ status: actionToStatus(action, note.publishedAt), updatedAt: new Date() })
		.where(eq(notes.id, noteId));
	return { kind: 'ok' };
}

function actionToStatus(action: 'private' | 'trash' | 'restore', publishedAt: Date | null): string {
	if (action === 'private') return 'private';
	if (action === 'trash') return 'trash';
	return publishedAt ? 'published' : 'draft';
}

export async function setNotePin(noteId: string, pinned: boolean): Promise<NoteRowActionResult> {
	const rows = await db
		.update(notes)
		.set({ pinAt: pinned ? new Date() : null, updatedAt: new Date() })
		.where(eq(notes.id, noteId))
		.returning({ id: notes.id });
	return rows.length > 0 ? { kind: 'ok' } : { kind: 'not-found' };
}

export async function setNoteAllowComment(
	noteId: string,
	allow: boolean
): Promise<NoteRowActionResult> {
	const rows = await db
		.update(notes)
		.set({ allowComment: allow, updatedAt: new Date() })
		.where(eq(notes.id, noteId))
		.returning({ id: notes.id });
	return rows.length > 0 ? { kind: 'ok' } : { kind: 'not-found' };
}

/** Empty string clears the gate; a new value revokes outstanding unlocks
 * automatically (unlock tokens bind the current password-hash fingerprint). */
export async function setNotePassword(
	noteId: string,
	password: string
): Promise<NoteRowActionResult> {
	if (password.length > 200) return { kind: 'invalid', message: '密码过长' };
	const passwordHash = password === '' ? null : hashNotePassword(password);
	const rows = await db
		.update(notes)
		.set({ passwordHash, updatedAt: new Date() })
		.where(eq(notes.id, noteId))
		.returning({ id: notes.id });
	return rows.length > 0 ? { kind: 'ok' } : { kind: 'not-found' };
}

/** Emotions live in `meta.emotions` (ledger §13.4); write is fail-closed
 * against the closed 38-token Apple vocabulary (§8.1). */
export async function setNoteEmotions(
	noteId: string,
	tokens: string[]
): Promise<NoteRowActionResult> {
	const allowed = new Set<string>(NOTE_EMOTIONS);
	if (tokens.some((token) => !allowed.has(token))) {
		return { kind: 'invalid', message: '情绪取值无效' };
	}
	const [note] = await db
		.select({ id: notes.id, meta: notes.meta })
		.from(notes)
		.where(eq(notes.id, noteId))
		.limit(1);
	if (!note) return { kind: 'not-found' };
	const nextMeta = { ...(note.meta ?? {}), emotions: tokens };
	await db.update(notes).set({ meta: nextMeta, updatedAt: new Date() }).where(eq(notes.id, noteId));
	return { kind: 'ok' };
}

/* ── Read helpers for the lists ──────────────────────────────────────── */

/** Notes that already have a pending (unpublished) draft - list badge. */
export async function draftsForNotes(noteIds: string[]): Promise<Set<string>> {
	if (noteIds.length === 0) return new Set();
	const rows = await db
		.select({ refId: drafts.refId })
		.from(drafts)
		.where(and(eq(drafts.refType, 'note'), inArray(drafts.refId, noteIds)));
	return new Set(rows.map((r) => r.refId).filter((id): id is string => id != null));
}
