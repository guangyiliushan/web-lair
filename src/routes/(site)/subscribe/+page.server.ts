import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { subscriptionConfirmMail } from '$lib/server/mail/templates';
import { sendMailOrDevLog } from '$lib/server/mail/transport';
import {
	isSubscriptionLang,
	normalizeEmail,
	requestSubscription
} from '$lib/server/services/subscriptions';
import type { Actions } from './$types';

/**
 * Public subscription form (deploy batch D-2, §F #9). Double opt-in: the row
 * starts `pending` and only becomes `subscribed` after the confirm page POSTs
 * the token from the email (email scanners prefetch GET links, so confirmation
 * is deliberately not a GET side effect).
 *
 * Anti-abuse: honeypot field, 10 attempts/hour per client address (fail-open),
 * and an identical success message for pending / already-subscribed so the
 * form cannot be used to enumerate subscribers.
 */
const SUBSCRIBE_RATE_LIMIT = { limit: 10, windowSeconds: 60 * 60 } as const;

export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		const form = await request.formData();
		// Bots fill every input; humans never see this one.
		if (String(form.get('website') ?? '').trim() !== '') return { success: true };

		const email = normalizeEmail(String(form.get('email') ?? ''));
		if (!email) return fail(400, { message: m.subscribe_err_email() });

		const address = (() => {
			try {
				return getClientAddress() || 'unknown';
			} catch {
				// dev without ADDRESS_HEADER: one shared bucket
				return 'unknown';
			}
		})();
		const rate = await rateLimit(
			getCache(),
			`limits:subscribe:${address}`,
			SUBSCRIBE_RATE_LIMIT.limit,
			SUBSCRIBE_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) return fail(429, { message: m.subscribe_err_rate() });

		const locale = getLocale();
		const lang = isSubscriptionLang(locale) ? locale : 'en';
		const outcome = await requestSubscription({ email, lang, source: 'subscribe-page' });

		if (outcome.kind === 'pending') {
			const origin = (env.ORIGIN ?? '').replace(/\/$/, '');
			const url = `${origin}/${lang}/subscribe/confirm?token=${outcome.token}`;
			try {
				await sendMailOrDevLog({ to: email, ...subscriptionConfirmMail(lang, url) });
			} catch (error) {
				console.error('[subscribe] confirmation mail failed', error);
				return fail(503, { message: m.subscribe_err_mail() });
			}
		}

		return { success: true };
	}
};
