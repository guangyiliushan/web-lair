import { fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import { m } from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/authz';
import { isUuid } from '$lib/utils/uuid';
import { parseCommentAnchorDraft } from '$lib/server/comment-anchor';
import type { CommentAnchorDraft } from '$lib/utils/comment-anchor';
import { deleteComment, editComment, type SubmitCommentResult } from './comments';

// Shared reader-action handlers: the posts / notes / pages routes wire their
// `edit` / `delete` actions straight onto these so the three hosts cannot
// drift apart, and every host maps submit/reply results through
// `commentSubmitResponse` below for the same reason. Per-host page gates (the
// note unlock session) stay in the hosts as a page-level UX layer; the
// authoritative gate is the ownership CAS in the service.
//
// A route adapter, not a service: it lives beside comments.ts because it
// wraps exactly that service's write entry points - RequestEvent in,
// ActionResult out.

/** Form fields shared by both actions; null when the id is malformed. */
async function readCommentActionForm(
	event: RequestEvent
): Promise<{ id: string; text: string } | null> {
	const form = await event.request.formData();
	const id = form.get('id')?.toString() ?? '';
	if (!isUuid(id)) return null;
	return { id, text: form.get('text')?.toString() ?? '' };
}

/**
 * Segment-anchor fields carried by a `?/comment` submission:
 * ord/start/end/exact plus the block length and fingerprint the reader saw.
 * Absent fields = an article-level comment; present-but-partial or malformed is
 * rejected by the caller instead of silently degrading to an article comment.
 */
export type AnchorDraftRead =
	{ kind: 'none' } | { kind: 'ok'; draft: CommentAnchorDraft } | { kind: 'invalid' };

export function readCommentAnchorDraft(form: FormData): AnchorDraftRead {
	// Length and fingerprint are part of the contract now: a payload missing them
	// would silently disable the stale-ord guard - exactly the class of drift
	// the current contract prevents.
	const fields = [
		'anchorOrd',
		'anchorStart',
		'anchorEnd',
		'anchorExact',
		'anchorLength',
		'anchorFingerprint'
	] as const;
	const present = fields.filter((field) => form.get(field) !== null);
	if (present.length === 0) return { kind: 'none' };
	// A partial payload used to degrade into an article-level comment; it is a
	// broken client, so say so instead of silently dropping the anchor.
	if (present.length !== fields.length) return { kind: 'invalid' };

	const raw = fields.map((field) => form.get(field)?.toString() ?? '');
	// Cap before Zod expands the string into code points: the anchor limiter
	// runs later, so an oversized exact must not be materialised first.
	if (raw[3].length > 2000) return { kind: 'invalid' };
	const numeric = raw.slice(0, 3).map((value) => Number(value));
	if (numeric.some((value) => !Number.isInteger(value) || value < 0)) return { kind: 'invalid' };

	const blockLength = Number(raw[4]);
	if (!Number.isInteger(blockLength) || blockLength < 0) return { kind: 'invalid' };
	const draft = parseCommentAnchorDraft({
		ord: numeric[0],
		start: numeric[1],
		end: numeric[2],
		exact: raw[3],
		blockLength,
		blockFingerprint: raw[5]
	});
	return draft ? { kind: 'ok', draft } : { kind: 'invalid' };
}

/**
 * Shared submit/reply outcome mapping: the three hosts carried this switch
 * verbatim - a new SubmitCommentResult arm must now land here once. The
 * annotated return type keeps the switch exhaustive at the type level: a
 * grown union fails the build instead of falling through to an undefined
 * "success".
 */
export function commentSubmitResponse(
	result: SubmitCommentResult,
	event?: { setHeaders?(headers: Record<string, string>): void }
): { submitted: 'pending' | 'approved' } | ActionFailure<{ message: string }> {
	switch (result.kind) {
		case 'created':
			// A rule-blocked comment is stored as `rejected` for the audit trail,
			// but the public form can only render pending/approved. Surface a
			// neutral failure instead of pretending it was queued.
			if (result.state === 'rejected') {
				return fail(400, { message: m.comment_rejected() });
			}
			return { submitted: result.state };
		case 'throttled':
			// Rate answers carry Retry-After so a client can back off without guessing.
			event?.setHeaders?.({ 'retry-after': String(result.windowSeconds) });
			return fail(429, { message: m.comment_throttled() });
		case 'unavailable':
			event?.setHeaders?.({ 'retry-after': '60' });
			return fail(503, { message: m.auth_err_unavailable() });
		case 'unverified':
			return fail(403, { message: m.comment_verify_hint() });
		case 'disabled':
			// 403, not 404: the thread exists and stays readable, but new
			// comments are closed site-wide - the rejection must be explicit.
			return fail(403, { message: m.comment_disabled() });
		case 'blocked':
			// Request-time CIDR block: same neutral copy as an unavailable target -
			// the block list is not echoed back.
			return fail(403, { message: m.comment_error_blocked() });
		case 'empty':
		case 'too-long':
			return fail(400, { message: m.comment_error_generic() });
		case 'parent-unavailable':
			return fail(400, { message: m.comment_error_parent() });
		case 'stale-anchor':
			return fail(400, { message: m.comment_error_stale_anchor() });
		case 'target-unavailable':
			return fail(404, { message: m.comment_error_unavailable() });
	}
}

export async function commentEditAction(event: RequestEvent) {
	const user = requireUser();
	// Edit-specific copy: the reader is not "posting a comment" here.
	if (!user.emailVerified) return fail(403, { message: m.comment_action_unverified() });

	const fields = await readCommentActionForm(event);
	if (!fields) return fail(400, { message: m.comment_error_generic() });

	const result = await editComment({ commentId: fields.id, text: fields.text, user });
	switch (result.kind) {
		case 'updated':
			// Reuses the composer flash: an edited comment re-enters review
			// (pending) unless the author auto-approves.
			if (result.state === 'rejected') {
				return fail(400, { message: m.comment_rejected() });
			}
			return { submitted: result.state };
		case 'throttled':
			return fail(429, { message: m.comment_throttled() });
		case 'unverified':
			return fail(403, { message: m.comment_action_unverified() });
		case 'empty':
		case 'too-long':
			return fail(400, { message: m.comment_error_generic() });
		case 'unavailable':
			return fail(404, { message: m.comment_action_unavailable() });
	}
}

export async function commentDeleteAction(event: RequestEvent) {
	const user = requireUser();
	if (!user.emailVerified) return fail(403, { message: m.comment_action_unverified() });

	const fields = await readCommentActionForm(event);
	if (!fields) return fail(400, { message: m.comment_error_generic() });

	const result = await deleteComment({ commentId: fields.id, user });
	switch (result.kind) {
		case 'deleted':
			return { deleted: true };
		case 'unverified':
			return fail(403, { message: m.comment_action_unverified() });
		case 'unavailable':
			return fail(404, { message: m.comment_action_unavailable() });
	}
}
