import { runMailProbe, type JobContext } from '#jobs-sdk';

/**
 * mail.probe (M6 P4, F-10): daily SMTP `verify()` with the transport's own
 * settings derivation, plus one real mail to the owner on the site-local
 * Sunday (unique subject, message id recorded in the run ledger). Failures go
 * through the notification seam and the external healthchecks check.
 *
 * The core lives in `mail/probe-job.ts` and is loaded lazily through the SDK
 * (nodemailer never enters the builtin import graph); this file imports only
 * `#jobs-sdk` (J-2).
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		await runMailProbe(ctx);
	}
};
