import { fail, type RequestEvent } from '@sveltejs/kit';
import { m } from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/authz';
import { isUuid } from '$lib/utils/uuid';
import { deleteComment, editComment } from './comments';

/**
 * Shared reader-action handlers (comment P4): the posts / notes / pages
 * routes wire their `edit` / `delete` actions straight onto these so the
 * three hosts cannot drift apart. Per-host page gates (the note unlock
 * session) stay in the hosts as a page-level UX layer; the authoritative
 * gate is the ownership CAS in the service (review 2026-10-12).
 */

/** Form fields shared by both actions; null when the id is malformed. */
async function readCommentActionForm(
	event: RequestEvent
): Promise<{ id: string; text: string } | null> {
	const form = await event.request.formData();
	const id = form.get('id')?.toString() ?? '';
	if (!isUuid(id)) return null;
	return { id, text: form.get('text')?.toString() ?? '' };
}

export async function commentEditAction(event: RequestEvent) {
	const user = requireUser();
	if (!user.emailVerified) return fail(403, { message: m.comment_verify_hint() });

	const fields = await readCommentActionForm(event);
	if (!fields) return fail(400, { message: m.comment_error_generic() });

	const result = await editComment({ commentId: fields.id, text: fields.text, user });
	switch (result.kind) {
		case 'updated':
			// Reuses the composer flash: an edited comment re-enters review
			// (pending) unless the author auto-approves.
			return { submitted: result.state };
		case 'throttled':
			return fail(429, { message: m.comment_throttled() });
		case 'unverified':
			return fail(403, { message: m.comment_verify_hint() });
		case 'empty':
		case 'too-long':
			return fail(400, { message: m.comment_error_generic() });
		case 'unavailable':
			return fail(404, { message: m.comment_action_unavailable() });
	}
}

export async function commentDeleteAction(event: RequestEvent) {
	const user = requireUser();
	if (!user.emailVerified) return fail(403, { message: m.comment_verify_hint() });

	const fields = await readCommentActionForm(event);
	if (!fields) return fail(400, { message: m.comment_error_generic() });

	const result = await deleteComment({ commentId: fields.id, user });
	switch (result.kind) {
		case 'deleted':
			return { deleted: true };
		case 'unverified':
			return fail(403, { message: m.comment_verify_hint() });
		case 'unavailable':
			return fail(404, { message: m.comment_action_unavailable() });
	}
}
