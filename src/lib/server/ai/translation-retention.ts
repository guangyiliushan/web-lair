import { and, eq, lt, sql } from 'drizzle-orm';
import { translations } from '../db/content/translation.schema.ts';
import { getOption } from '../config/options-registry.ts';
import type { AiDb } from './types.ts';

/**
 * Discarded-translation retention.
 *
 * An accepted row becomes the target's content and a draft is work in
 * progress; only `discarded` rows are pure history. They stay long enough for
 * the operator to notice a bad batch (default 180 days) and then go, so the
 * table does not grow without bound. `discardDays = 0` disables the sweep.
 *
 * This lives beside the translation job rather than in `jobs-prune.ts` because
 * `translations` pulls the content schema graph (posts + notes), and the prune
 * builtin must stay importable from `#jobs-sdk` alone. The prune job calls the
 * lazy wrapper in `jobs-sdk.ts`.
 */
export async function pruneDiscardedTranslations(
	db: AiDb,
	now: Date = new Date()
): Promise<number> {
	const { discardDays } = await getOption('translations.retention', db as never);
	if (discardDays <= 0) return 0;
	const cutoff = new Date(now.getTime() - discardDays * 24 * 60 * 60 * 1000);
	const removed = await db
		.delete(translations)
		.where(
			and(
				eq(translations.status, 'discarded'),
				// `updated_at` is what the workbench shows as the discard time: a
				// row touched later is not old yet, and `created_at` alone would
				// delete a freshly discarded long-lived draft.
				lt(sql`coalesce(${translations.updatedAt}, ${translations.createdAt})`, cutoff)
			)
		)
		.returning({ id: translations.id });
	return removed.length;
}
