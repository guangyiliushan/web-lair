import { subscriptionByToken, unsubscribe } from '$lib/server/services/subscriptions';
import { isSubscriptionToken } from '$lib/server/services/subscription-token';
import type { Actions, PageServerLoad } from './$types';

/** Unsubscribe landing page (same GET-render / POST-mutate split as confirm). */
export const load: PageServerLoad = async ({ url, setHeaders }) => {
	// The token is in this URL; strict-origin keeps the path out of Referer
	// while still sending a real Origin header (no-referrer sends Origin: null,
	// which SvelteKit's form CSRF check rejects).
	setHeaders({ 'referrer-policy': 'strict-origin', 'cache-control': 'no-store' });
	const token = url.searchParams.get('token') ?? '';
	const row = isSubscriptionToken(token) ? await subscriptionByToken(token) : null;
	return {
		token,
		status: row?.status ?? ('invalid' as const),
		email: row?.email ?? null
	};
};

export const actions: Actions = {
	default: async ({ request }) => {
		const token = String((await request.formData()).get('token') ?? '');
		if (!isSubscriptionToken(token)) return { result: 'invalid' as const };
		return { result: await unsubscribe(token) };
	}
};
