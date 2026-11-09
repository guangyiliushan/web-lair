import { eq } from 'drizzle-orm';
import { baseLocale } from '$lib/paraglide/runtime';
import { getOption, OPTION_LANGS } from '$lib/server/config/options-registry';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';

type OptionLang = (typeof OPTION_LANGS)[number];

const LANG_SET: ReadonlySet<string> = new Set(OPTION_LANGS);

function isOptionLang(value: unknown): value is OptionLang {
	return typeof value === 'string' && LANG_SET.has(value);
}

/**
 * The language a new post starts in (post-creation flow, task A3): the
 * author's saved account default when it is a real site language, else the
 * site default, else the base locale. A missing user or a stale value must
 * never break the editor, so every step degrades instead of throwing.
 */
export async function resolveWriterLang(userId: string | null): Promise<string> {
	if (userId) {
		const rows = await db
			.select({ defaultLang: user.defaultLang })
			.from(user)
			.where(eq(user.id, userId))
			.limit(1);
		const stored = rows[0]?.defaultLang;
		if (isOptionLang(stored)) return stored;
	}

	const siteDefault: unknown = await getOption('site.default_lang');
	if (isOptionLang(siteDefault)) return siteDefault;

	return baseLocale;
}
