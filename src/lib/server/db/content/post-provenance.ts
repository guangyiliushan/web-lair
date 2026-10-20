/** Closed sets for the public AI-provenance axes (mirror the DB CHECKs). */
export const WRITING_ORIGINS = ['none', 'assist', 'mostly_ai', 'ai_full'] as const;
export const VISUAL_ORIGINS = ['none', 'some', 'all'] as const;

export type WritingOrigin = (typeof WRITING_ORIGINS)[number];
export type VisualOrigin = (typeof VISUAL_ORIGINS)[number];

/** Draft-side shape staged in `drafts.payload` until publish. */
export interface PostProvenanceDraft {
	writingOrigin: WritingOrigin | null;
	visualOrigin: VisualOrigin | null;
	aiHelp: string[];
}

export interface PostDraftPayload {
	provenance: PostProvenanceDraft;
}

function isWritingOrigin(value: unknown): value is WritingOrigin {
	return typeof value === 'string' && (WRITING_ORIGINS as readonly string[]).includes(value);
}

function isVisualOrigin(value: unknown): value is VisualOrigin {
	return typeof value === 'string' && (VISUAL_ORIGINS as readonly string[]).includes(value);
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
	return {
		writingOrigin,
		visualOrigin: isVisualOrigin(value.visualOrigin) ? value.visualOrigin : null,
		aiHelp
	};
}

export function isEmptyProvenance(value: PostProvenanceDraft): boolean {
	return value.writingOrigin === null && value.visualOrigin === null && value.aiHelp.length === 0;
}

/** Compare a staged draft claim with the published row (order-insensitive help). */
export function provenanceEquals(
	a: PostProvenanceDraft | null,
	b: Pick<PostProvenanceDraft, 'writingOrigin' | 'visualOrigin' | 'aiHelp'> | null
): boolean {
	if (!a || !b) return a === b;
	return (
		a.writingOrigin === b.writingOrigin &&
		a.visualOrigin === b.visualOrigin &&
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
