import { and, eq } from 'drizzle-orm';
import { glossaryTerms } from '../db/content/glossary-term.schema.ts';
import type { AiDb } from './types.ts';

/**
 * Glossary wiring for the translation prompt.
 *
 * The table has existed since AI-1 with no consumer; this module is that
 * consumer. Two rules keep it from costing more than it earns:
 *
 * - **Only terms that actually occur in the source are injected.** A prompt
 *   listing 200 glossary rows for a 300-word note spends more tokens on the
 *   glossary than on the text, and buries the instruction it is trying to give.
 * - **There is a hard budget** (`MAX_TERMS`, `MAX_CHARS`). Overflow is dropped
 *   from the tail of the ranking, never silently truncating a term's
 *   translation.
 *
 * Hits are ranked by occurrence count, then by term length: a phrase that shows
 * up five times matters more than one that appears once, and among equals the
 * longer term is the more specific instruction.
 */

/** One glossary row as far as translation is concerned. */
export interface GlossaryEntry {
	term: string;
	translation: string;
	note: string | null;
	caseSensitive: boolean;
}

/** Most terms injected into one prompt. */
export const MAX_TERMS = 20;
/** Most characters the terminology block may add to the prompt. */
export const MAX_CHARS = 1200;

function occurrences(haystack: string, needle: string, caseSensitive: boolean): number {
	if (!needle) return 0;
	const hay = caseSensitive ? haystack : haystack.toLowerCase();
	const pin = caseSensitive ? needle : needle.toLowerCase();
	let count = 0;
	let at = hay.indexOf(pin);
	while (at !== -1) {
		count += 1;
		at = hay.indexOf(pin, at + pin.length);
	}
	return count;
}

/**
 * Enabled terms of this language pair that occur in `text`, ranked and capped.
 * Pure: the caller does the query, so the same function serves the prompt and
 * the post-generation check.
 */
export function selectGlossaryTerms(
	rows: readonly GlossaryEntry[],
	text: string
): (GlossaryEntry & { hits: number })[] {
	const scored = rows
		.map((row) => ({ ...row, hits: occurrences(text, row.term, row.caseSensitive) }))
		.filter((row) => row.hits > 0)
		.sort((a, b) => b.hits - a.hits || b.term.length - a.term.length);

	const selected: (GlossaryEntry & { hits: number })[] = [];
	let chars = 0;
	for (const row of scored) {
		if (selected.length >= MAX_TERMS) break;
		const cost = row.term.length + row.translation.length + 2;
		if (chars + cost > MAX_CHARS) break;
		chars += cost;
		selected.push(row);
	}
	return selected;
}

/** The prompt block, or null when nothing matched. */
export function glossaryPromptBlock(entries: readonly GlossaryEntry[]): string | null {
	if (entries.length === 0) return null;
	const lines = entries.map((entry) =>
		entry.note
			? `- ${entry.term} → ${entry.translation} (${entry.note})`
			: `- ${entry.term} → ${entry.translation}`
	);
	return ['Use these glossary translations exactly:', ...lines].join('\n');
}

/** A term the model was told about but did not use. */
export interface GlossaryMiss {
	term: string;
	expected: string;
}

/**
 * Terms whose required translation is absent from the output.
 *
 * This is a warning, not a failure: the model may have inflected the term (the
 * glossary stores a phrase, Japanese may add a particle). The workbench shows
 * the list so a human can decide whether the glossary or the translation is
 * wrong — refusing the whole candidate over it would be worse than useless.
 */
export function verifyGlossary(entries: readonly GlossaryEntry[], output: string): GlossaryMiss[] {
	const misses: GlossaryMiss[] = [];
	for (const entry of entries) {
		if (occurrences(output, entry.translation, entry.caseSensitive) === 0) {
			misses.push({ term: entry.term, expected: entry.translation });
		}
	}
	return misses;
}

/** Enabled rows for one language pair. */
export async function loadGlossary(
	db: AiDb,
	sourceLang: string,
	targetLang: string
): Promise<GlossaryEntry[]> {
	const rows = await db
		.select({
			term: glossaryTerms.term,
			translation: glossaryTerms.translation,
			note: glossaryTerms.note,
			caseSensitive: glossaryTerms.caseSensitive
		})
		.from(glossaryTerms)
		.where(
			and(
				eq(glossaryTerms.sourceLang, sourceLang),
				eq(glossaryTerms.targetLang, targetLang),
				eq(glossaryTerms.enabled, true)
			)
		);
	return rows;
}

/**
 * Everything the translate path needs: the selected entries (for the prompt and
 * for verification) plus the prompt block itself.
 */
export async function prepareGlossary(
	db: AiDb,
	input: { sourceLang: string; targetLang: string; text: string }
): Promise<{ entries: (GlossaryEntry & { hits: number })[]; block: string | null }> {
	const rows = await loadGlossary(db, input.sourceLang, input.targetLang);
	if (rows.length === 0) return { entries: [], block: null };
	const entries = selectGlossaryTerms(rows, input.text);
	return { entries, block: glossaryPromptBlock(entries) };
}
