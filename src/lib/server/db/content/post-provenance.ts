/**
 * Closed sets for the public AI-provenance axes (mirror the DB CHECKs).
 *
 * Only the *writing* axis lives on a post. The old `visual_origin` axis was
 * removed (2026-10-21): a post is text, and an AI-generated image is a property
 * of the **asset**, not of the article — it belongs to the media pipeline
 * (EXIF/C2PA at ingest), where each file can be judged on its own. Keeping a
 * post-level "some/all images are AI" claim duplicated that fact and went
 * stale as soon as an image was swapped.
 */
export const WRITING_ORIGINS = ['none', 'assist', 'mostly_ai', 'ai_full'] as const;

export type WritingOrigin = (typeof WRITING_ORIGINS)[number];

/** Draft-side shape staged in `drafts.payload` until publish. */
export interface PostProvenanceDraft {
	writingOrigin: WritingOrigin | null;
	aiHelp: string[];
}

export interface PostDraftPayload {
	provenance: PostProvenanceDraft;
}

function isWritingOrigin(value: unknown): value is WritingOrigin {
	return typeof value === 'string' && (WRITING_ORIGINS as readonly string[]).includes(value);
}

function normalizeHelp(value: unknown): string[] {
	const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	return [
		...new Set(
			values
				.map((item) => (typeof item === 'string' ? item.trim() : ''))
				.filter((item) => item.length > 0 && item.length <= 40)
		)
	].slice(0, 8);
}

/** Invalid enum values degrade to "not disclosed" rather than inventing a claim. */
export function normalizeProvenance(input: unknown): PostProvenanceDraft {
	const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
	const writingOrigin = isWritingOrigin(value.writingOrigin) ? value.writingOrigin : null;
	// A detail can only describe an AI-assisted writing claim; "No AI" +
	// "AI helped with …" is contradictory and must not reach the DB.
	const aiHelp =
		writingOrigin === 'assist' || writingOrigin === 'mostly_ai' || writingOrigin === 'ai_full'
			? normalizeHelp(value.aiHelp)
			: [];
	return { writingOrigin, aiHelp };
}

export function isEmptyProvenance(value: PostProvenanceDraft): boolean {
	return value.writingOrigin === null && value.aiHelp.length === 0;
}

/** Compare a staged draft claim with the published row (order-insensitive help). */
export function provenanceEquals(
	a: PostProvenanceDraft | null,
	b: Pick<PostProvenanceDraft, 'writingOrigin' | 'aiHelp'> | null
): boolean {
	if (!a || !b) return a === b;
	return (
		a.writingOrigin === b.writingOrigin &&
		[...a.aiHelp].sort().join('\u0000') === [...(b.aiHelp ?? [])].sort().join('\u0000')
	);
}

/** Read the optional provenance block out of a draft's JSONB payload. */
export function postProvenanceFromPayload(payload: unknown): PostProvenanceDraft | null {
	if (!payload || typeof payload !== 'object' || !('provenance' in payload)) return null;
	const raw = (payload as { provenance?: unknown }).provenance;
	// A malformed/partial payload is not an explicit "clear": only a present
	// plain object represents a staged claim; everything else means "absent".
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	return normalizeProvenance(raw);
}
