import { subscriptionByToken, unsubscribe } from '$lib/server/services/subscriptions';
import type { Actions, PageServerLoad } from './$types';

/** Unsubscribe landing page (same GET-render / POST-mutate split as confirm). */
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token') ?? '';
	const row = await subscriptionByToken(token);
	return {
		token,
		status: row?.status ?? ('invalid' as const),
		email: row?.email ?? null
	};
};

export const actions: Actions = {
	default: async ({ request }) => {
		const token = String((await request.formData()).get('token') ?? '');
		return { result: await unsubscribe(token) };
	}
};
