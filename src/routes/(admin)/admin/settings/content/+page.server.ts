import type { PageServerLoad } from './$types';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';

/**
 * Foundation read view for Content (W3.5). W6 adds the real forms; the
 * current values are displayed so the page is truthful without a single
 * dead toggle. `comments.moderation` stays owned by the AI page (single
 * writer), which is why this page links to it instead of duplicating it.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
	const [moderation, presenceEnabled, readerView, readerDots, notesGate, friendsApply] =
		await Promise.all([
			getOption('comments.moderation'),
			getOption('presence.enabled'),
			getOption('presence.readerView'),
			getOption('presence.readerDots'),
			getOption('notes.gate'),
			getOption('friends.apply')
		]);
	return {
		moderation: moderation.enabled,
		presence: { enabled: presenceEnabled, readerView, readerDots },
		notesGate,
		friendsApply
	};
};
