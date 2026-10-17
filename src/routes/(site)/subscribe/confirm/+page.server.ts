import { confirmSubscription, subscriptionByToken } from '$lib/server/services/subscriptions';
import type { Actions, PageServerLoad } from './$types';

/**
 * Confirmation landing page. The email link is a GET that only RENDERS the
 * button; the state change happens in the POST action below, so mail scanners
 * that prefetch links cannot confirm on the reader's behalf.
 */
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
		return { result: await confirmSubscription(token) };
	}
};
