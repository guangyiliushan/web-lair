import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { requestAddress } from '$lib/server/security/request-address';
import { subscriptionConfirmMail } from '$lib/server/mail/templates';
import { sendMailOrDevLog } from '$lib/server/mail/transport';
import {
	CONSENT_VERSION,
	discardPendingToken,
	isSubscriptionLang,
	restoreSubscription,
	normalizeEmail,
	requestSubscription,
	subscribeAddressKey
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
const SUBSCRIBE_ADDRESS_LIMIT = { limit: 5, windowSeconds: 24 * 60 * 60 } as const;

export const actions: Actions = {
	default: async ({ request, getClientAddress, url: requestUrl }) => {
		const form = await request.formData();
		// Bots fill every input; humans never see this one.
		if (String(form.get('website') ?? '').trim() !== '') return { success: true };

		const email = normalizeEmail(String(form.get('email') ?? ''));
		if (!email) return fail(400, { message: m.subscribe_err_email() });

		const address = requestAddress(getClientAddress);
		const rate = await rateLimit(
			getCache(),
			`limits:subscribe:${address}`,
			SUBSCRIBE_RATE_LIMIT.limit,
			SUBSCRIBE_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) return fail(429, { message: m.subscribe_err_rate() });

		// Per-address daily cap, keyed by HMAC so the cache never holds a
		// plaintext address. A hit must look exactly like success (no mail, no
		// row) — otherwise the form becomes an enumeration oracle. A missing
		// key degrades to IP-only limiting with one explicit log.
		const addressKey = subscribeAddressKey(email);
		if (addressKey) {
			const addressRate = await rateLimit(
				getCache(),
				`limits:subscribe:addr:${addressKey}`,
				SUBSCRIBE_ADDRESS_LIMIT.limit,
				SUBSCRIBE_ADDRESS_LIMIT.windowSeconds
			);
			if (!addressRate.allowed) {
				console.warn('[subscribe] address cap hit; confirmation mail not sent');
				return { success: true };
			}
		}

		const locale = getLocale();
		const lang = isSubscriptionLang(locale) ? locale : 'en';
		const outcome = await requestSubscription({ email, lang, source: 'subscribe-page' });

		if (outcome.kind === 'pending' && outcome.send !== false) {
			// ORIGIN empty (the .env.example default) would mail a relative link.
			const configuredOrigin = (env.ORIGIN ?? '').trim().replace(/\/$/, '');
			const origin = configuredOrigin || requestUrl.origin;
			const confirmUrl = `${origin}/${lang}/subscribe/confirm?token=${outcome.token}`;
			const optOutUrl = `${origin}/${lang}/unsubscribe?token=${outcome.token}`;
			try {
				await sendMailOrDevLog({
					to: email,
					...subscriptionConfirmMail(lang, confirmUrl, optOutUrl, CONSENT_VERSION)
				});
			} catch (error) {
				// Roll the never-mailed pending row back, otherwise the resend
				// cooldown turns the retry into a success with no mail. A 2xx
				// responseCode means the server accepted the message, so the row
				// must survive even though nodemailer then threw.
				const accepted = (error as { responseCode?: number }).responseCode;
				const delivered = typeof accepted === 'number' && accepted >= 200 && accepted < 300;
				if (!delivered) {
					try {
						if (outcome.previous) {
							await restoreSubscription(outcome.token, outcome.previous);
						} else {
							await discardPendingToken(outcome.token);
						}
					} catch (rollbackError) {
						console.error('[subscribe] pending rollback failed', rollbackError);
					}
				}
				console.error('[subscribe] confirmation mail failed', error);
				return fail(503, { message: m.subscribe_err_mail() });
			}
		}

		return { success: true };
	}
};
