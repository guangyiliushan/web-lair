import { m } from '$lib/paraglide/messages';
import type { AcceptTranslationResult, TranslationRequestResult } from './translations.ts';

/**
 * One copy source for the translation failure kinds. The workbench and the
 * editor drawer both answer with these strings, so a new result kind cannot
 * drift between the two surfaces.
 */
export const ACCEPT_ERROR_KEYS: Record<
	Exclude<AcceptTranslationResult['kind'], 'accepted'>,
	() => string
> = {
	'not-found': () => m.admin_translations_err_candidate_missing(),
	'not-draft': () => m.admin_translations_err_not_draft(),
	empty: () => m.admin_translations_err_empty(),
	stale: () => m.admin_translations_err_stale(),
	'source-missing': () => m.admin_translations_err_source_missing(),
	'target-published': () => m.admin_translations_err_target_published(),
	'target-conflict': () => m.admin_translations_err_target_conflict(),
	'target-draft-exists': () => m.admin_translations_err_target_draft_exists(),
	'slug-conflict': () => m.admin_translations_err_slug_conflict(),
	busy: () => m.admin_translations_err_busy()
};

export function acceptMessage(kind: AcceptTranslationResult['kind']): string {
	// Acceptance is never an error; the branch only keeps the caller's union
	// type honest.
	if (kind === 'accepted') return m.admin_translations_err_generic();
	return ACCEPT_ERROR_KEYS[kind]();
}

export function requestMessage(kind: TranslationRequestResult['kind'], reason?: string): string {
	switch (kind) {
		case 'lang-exists':
			return m.admin_translations_err_lang_exists();
		case 'same-lang':
			return m.admin_translations_err_same_lang();
		case 'too-short':
			return m.admin_translations_err_too_short();
		case 'not-found':
			return m.admin_translations_err_source_missing();
		case 'skipped':
			if (reason === 'not-source') return m.admin_translations_err_not_source();
			if (reason === 'empty-source') return m.admin_translations_err_empty_source();
			return m.admin_translations_err_generic();
		default:
			// `queued` / `exists` are successes, and `bad-lang` is filtered by
			// the caller's allowlist; both only reach here defensively.
			return m.admin_translations_err_generic();
	}
}
