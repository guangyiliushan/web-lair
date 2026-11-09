import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getOption } from '../config/options-registry.ts';
import { notes } from '../db/content/note.schema.ts';
import { posts } from '../db/content/post.schema.ts';
import type { TranslationProgress } from '../db/content/translation.schema.ts';
import { runAiCall } from './client.ts';
import { AiError } from './errors.ts';
import { prepareGlossary, verifyGlossary, type GlossaryMiss } from './glossary.ts';
import {
	protectMarkdown,
	restoreMarkdown,
	restoreMarkdownPartial,
	validateTranslation,
	type ProtectedMarkdown
} from './protect.ts';
import { segmentMarkdown, type TranslationChunk } from './segment.ts';
import type { AiDeps, AiTrigger } from './types.ts';

/**
 * Hard guardrail for one source document. Segmentation is what makes a long
 * document work; this only stops an accidental 10 MB paste from spending an
 * unbounded amount of money in one job.
 */
export const MAX_TRANSLATION_CHARS = 200_000;

export type TranslationSourceType = 'post' | 'note';

export interface TranslationCandidate {
	title: string;
	content: string;
	summary: string | null;
	contentFormat: string;
	sourceHash: string;
	provider: string;
	model: string;
}

const LANG_NAMES: Record<string, string> = {
	en: 'English',
	'zh-cn': 'Simplified Chinese',
	ja: 'Japanese'
};

function languageName(lang: string): string {
	return LANG_NAMES[lang] ?? lang;
}

export function sourceHash(input: {
	title: string;
	content: string | null;
	summary: string | null;
	contentFormat: string;
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				input.title,
				(input.content ?? '').replace(/\r\n/g, '\n'),
				input.summary ?? '',
				input.contentFormat
			])
		)
		.digest('hex');
}

function systemPrompt(sourceLang: string, targetLang: string, styleGuide: string): string {
	return [
		`You are a professional translator. Translate from ${languageName(sourceLang)} to ${languageName(targetLang)}.`,
		'Preserve every [[WL…]] placeholder exactly once, in the same order. They stand for code, URLs, image paths, mentions and directives; never translate, remove or duplicate them.',
		'Keep the markdown structure (headings, lists, blockquotes, tables, link text) intact. Do not add sections, commentary or explanations.',
		'Output only the translated markdown.',
		styleGuide.trim() ? `Style guide:\n${styleGuide.trim()}` : ''
	]
		.filter(Boolean)
		.join('\n');
}

/**
 * Source characters per chunk. The budget is time-based, not model-based:
 * 3-4k output tokens is about 60-90 seconds, and CJK text is denser per
 * output token. Calibrate both numbers from `ai_usage.output_tokens`.
 */
function chunkCharsFor(sourceLang: string): number {
	return sourceLang === 'en' ? 6_000 : 3_000;
}

/**
 * Code-point length window per script pair. The first live run (a 336-char
 * zh-cn post) produced 1140 English characters - 3.41x - which the default
 * 2.5 ceiling rejected as if the translation had been padded. CJK to Latin
 * expands; Latin to CJK contracts; same-script pairs keep the default.
 */
export function lengthRatioFor(
	sourceLang: string,
	targetLang: string
): { min: number; max: number } {
	const cjk = (lang: string): boolean => lang === 'zh-cn' || lang === 'ja';
	if (cjk(sourceLang) && !cjk(targetLang)) return { min: 1.0, max: 5.0 };
	if (!cjk(sourceLang) && cjk(targetLang)) return { min: 0.15, max: 1.0 };
	return { min: 0.35, max: 2.5 };
}

/** Continuity instructions for one part of a multi-part document. */
function chunkSystemPrompt(input: {
	base: string;
	index: number;
	total: number;
	heading: string | null;
	previousTail: string;
}): string {
	if (input.total <= 1) return input.base;
	const parts = [
		input.base,
		`This is part ${input.index + 1} of ${input.total} of one document. Translate only this part. Do not summarise, add transitions, or repeat text translated in another part.`
	];
	if (input.heading) parts.push(`Current section heading in the source: ${input.heading}`);
	if (input.previousTail) {
		parts.push(
			`The previous part ended with (translated):\n${input.previousTail}\nKeep terminology and tone consistent with it.`
		);
	}
	return parts.join('\n\n');
}

export interface ChunkCallRequest {
	chunk: TranslationChunk;
	system: string;
	index: number;
	total: number;
	onProgress?: (text: string) => void;
}

export interface ChunkCallResult {
	text: string;
	provider: string;
	model: string;
}

export type ChunkCaller = (request: ChunkCallRequest) => Promise<ChunkCallResult>;

/**
 * Translate a document chunk by chunk, in order, and return the assembled
 * body with every placeholder restored. The provider call is injected so the
 * orchestration (continuity prompt, per-chunk validation, preview, assembly)
 * is testable without a provider or a database.
 *
 * Per-chunk checks skip the length ratio: a short CJK chunk is legitimately
 * many times longer in English, and the ratio only makes sense on the final
 * document. `restoreMarkdown` is the last gate: every placeholder must appear
 * exactly once across the assembly.
 */
export async function translateChunks(
	input: {
		baseSystem: string;
		protectedDoc: ProtectedMarkdown;
		chunks: readonly TranslationChunk[];
		onProgress?: (text: string) => void;
		/**
		 * Texts a previous run already finished, aligned with `chunks`. A
		 * non-empty entry skips the model call and is reused for continuity.
		 */
		completed?: ReadonlyArray<string | undefined>;
		/** Called once per newly translated chunk so the caller can persist it. */
		onChunk?: (index: number, text: string) => void;
	},
	call: ChunkCaller
): Promise<{ content: string; provider: string; model: string }> {
	const total = input.chunks.length;
	if (total === 0) throw new AiError('invalid_output', 'Translation produced no chunks');
	const translated: string[] = [];
	let provider = '';
	let model = '';

	const preview = (index: number, current: string): string => {
		const parts = [...translated.slice(0, index), current];
		const assembled = input.chunks
			.slice(0, index + 1)
			.map((chunk, position) =>
				position === 0 ? parts[0] : chunk.separator + (parts[position] ?? '')
			)
			.join('');
		return restoreMarkdownPartial(assembled, input.protectedDoc);
	};

	for (let index = 0; index < total; index++) {
		const finished = input.completed?.[index];
		if (typeof finished === 'string' && finished.trim()) {
			// A resumed chunk: keep its text (it is what the continuity prompt
			// and the final assembly need) without paying for it again.
			translated.push(finished);
			continue;
		}
		const chunk = input.chunks[index];
		const result = await call({
			chunk,
			system: chunkSystemPrompt({
				base: input.baseSystem,
				index,
				total,
				heading: chunk.heading,
				previousTail: index > 0 ? translated[index - 1].slice(-400) : ''
			}),
			index,
			total,
			onProgress: input.onProgress
				? (text: string) => input.onProgress!(preview(index, text))
				: undefined
		});
		provider = result.provider;
		model = result.model;
		const check = validateTranslation(chunk.text, result.text, { checkLengthRatio: false });
		if (!check.ok) {
			throw new AiError(
				'invalid_output',
				`Translation part ${index + 1}/${total} failed deterministic checks: ${check.reason}`,
				{ provider: result.provider }
			);
		}
		translated.push(result.text);
		input.onChunk?.(index, result.text);
	}

	const assembled = input.chunks
		.map((chunk, index) => (index === 0 ? translated[0] : chunk.separator + translated[index]))
		.join('');
	let content: string;
	try {
		content = restoreMarkdown(assembled, input.protectedDoc);
	} catch (caught) {
		throw new AiError(
			'invalid_output',
			`Translation placeholders did not survive assembly: ${caught instanceof Error ? caught.message : String(caught)}`,
			{ provider }
		);
	}
	return { content, provider, model };
}

interface LoadedSource {
	title: string;
	content: string | null;
	summary: string | null;
	lang: string;
	contentFormat: string;
	translatedFrom: string | null;
}

async function loadSource(
	db: AiDeps['db'],
	type: TranslationSourceType,
	id: string
): Promise<LoadedSource | null> {
	if (type === 'post') {
		const [row] = await db
			.select({
				title: posts.title,
				content: posts.content,
				summary: posts.summary,
				lang: posts.lang,
				contentFormat: posts.contentFormat,
				translatedFrom: posts.translatedFromPostId
			})
			.from(posts)
			.where(eq(posts.id, id))
			.limit(1);
		return row ?? null;
	}
	const [row] = await db
		.select({
			title: notes.title,
			content: notes.content,
			lang: notes.lang,
			contentFormat: notes.contentFormat,
			translatedFrom: notes.translatedFromNoteId
		})
		.from(notes)
		.where(eq(notes.id, id))
		.limit(1);
	return row ? { ...row, summary: null } : null;
}

/**
 * Generate one translation candidate. The source is never modified; the
 * caller writes the result into `translations` (the workbench record).
 */
export async function generateTranslation(
	input: {
		sourceType: TranslationSourceType;
		sourceId: string;
		targetLang: string;
		manual?: boolean;
		actorId?: string | null;
		trigger?: AiTrigger;
		/**
		 * Live body text while it streams, with placeholders already restored so
		 * the caller can persist a readable preview. Title and summary calls are
		 * not reported: they are short and would overwrite the body preview.
		 */
		onProgress?: (text: string) => void;
		/**
		 * Chunk progress persisted by a previous tick. Reused only when the
		 * source hash, chunk size and chunk count still match.
		 */
		progress?: TranslationProgress | null;
		/** The plan for this run, so the caller can persist chunk progress. */
		onPlan?: (plan: {
			sourceHash: string;
			total: number;
			maxChars: number;
			prior: TranslationProgress | null;
		}) => void;
		/** Report a newly finished chunk to the caller (persisted for resume). */
		onChunk?: (index: number, text: string) => void;
		/** Glossary terms the model was asked to use but did not. Advisory. */
		onGlossaryMisses?: (misses: GlossaryMiss[]) => void;
	},
	deps: AiDeps
): Promise<TranslationCandidate> {
	const source = await loadSource(deps.db, input.sourceType, input.sourceId);
	if (!source) throw new AiError('bad_request', 'Translation source not found');
	if (source.translatedFrom) {
		throw new AiError('bad_request', 'Chained translations are not allowed');
	}
	if (source.lang === input.targetLang) {
		throw new AiError('bad_request', 'Source and target language are identical');
	}
	if (!source.title.trim() || !(source.content ?? '').trim()) {
		throw new AiError('bad_request', 'Source title/content is empty');
	}
	const styleGuide = (await getOption('ai.styleGuide', deps.db)).text;
	// Glossary first: only terms that occur in THIS source reach the prompt, so
	// a long table costs nothing on a note that mentions none of them.
	const glossary = await prepareGlossary(deps.db, {
		sourceLang: source.lang,
		targetLang: input.targetLang,
		text: `${source.title}\n${source.content ?? ''}`
	});
	const system = [systemPrompt(source.lang, input.targetLang, styleGuide), glossary.block]
		.filter(Boolean)
		.join('\n');

	const protectedDoc = protectMarkdown(source.content ?? '');
	const protectedLength = [...protectedDoc.text].length;
	if (protectedLength > MAX_TRANSLATION_CHARS) {
		throw new AiError(
			'bad_request',
			`Source is too long to translate (${protectedLength} > ${MAX_TRANSLATION_CHARS})`
		);
	}
	const maxChars = chunkCharsFor(source.lang);
	const chunks = segmentMarkdown(protectedDoc.text, { maxChars });
	const currentHash = sourceHash(source);
	const prior =
		input.progress &&
		input.progress.sourceHash === currentHash &&
		input.progress.maxChars === maxChars &&
		input.progress.total === chunks.length
			? input.progress
			: null;
	const completed = prior?.chunks?.map((chunk) =>
		chunk.status === 'done' ? chunk.text : undefined
	);
	input.onPlan?.({ sourceHash: currentHash, total: chunks.length, maxChars, prior });
	const translated = await translateChunks(
		{
			baseSystem: system,
			protectedDoc,
			chunks,
			onProgress: input.onProgress,
			completed,
			onChunk: input.onChunk
		},
		async ({ chunk, system: chunkSystem, onProgress }) => {
			const call = await runAiCall(
				{
					task: 'translation',
					functionSlot: 'translation',
					system: chunkSystem,
					user: chunk.text,
					translation: {
						text: chunk.text,
						sourceLang: source.lang,
						targetLang: input.targetLang
					},
					relatedType: input.sourceType,
					relatedId: input.sourceId,
					maxOutputTokens: 8_000,
					temperature: 0.1,
					thinking: 'off',
					manual: input.manual,
					actorId: input.actorId ?? null,
					trigger: input.trigger,
					onProgress
				},
				deps
			);
			return { text: call.text, provider: call.provider, model: call.model };
		}
	);
	const content = translated.content;
	const contentCheck = validateTranslation(source.content ?? '', content, {
		lengthRatio: lengthRatioFor(source.lang, input.targetLang)
	});
	if (!contentCheck.ok) {
		throw new AiError(
			'invalid_output',
			`Translation failed deterministic checks: ${contentCheck.reason}`,
			{
				provider: translated.provider
			}
		);
	}

	// A failed title call must not discard the already-paid body: fall back
	// to the source title (the operator can translate it by hand).
	const titleText = source.title.trim();
	let title = titleText;
	try {
		const titleCall = await runAiCall(
			{
				task: 'translation',
				functionSlot: 'translation',
				system,
				user: titleText,
				translation: { text: titleText, sourceLang: source.lang, targetLang: input.targetLang },
				relatedType: input.sourceType,
				relatedId: input.sourceId,
				maxOutputTokens: 500,
				temperature: 0.1,
				thinking: 'off',
				manual: input.manual,
				actorId: input.actorId ?? null,
				trigger: input.trigger
			},
			deps
		);
		const translatedTitle = titleCall.text.trim();
		if (
			!translatedTitle ||
			translatedTitle.length > 300 ||
			/<\/?[a-z][^>]*>/i.test(translatedTitle)
		) {
			throw new AiError('invalid_output', 'Translated title is empty or invalid', {
				provider: titleCall.provider
			});
		}
		title = translatedTitle;
	} catch (caught) {
		deps.log?.(
			'[ai] title translation fell back to the source title: ' +
				(caught instanceof Error ? caught.message : String(caught))
		);
	}

	let summary: string | null = null;
	if (source.summary?.trim()) {
		try {
			const summaryCall = await runAiCall(
				{
					task: 'translation',
					functionSlot: 'translation',
					system,
					user: source.summary.trim(),
					translation: {
						text: source.summary.trim(),
						sourceLang: source.lang,
						targetLang: input.targetLang
					},
					relatedType: input.sourceType,
					relatedId: input.sourceId,
					maxOutputTokens: 500,
					temperature: 0.1,
					thinking: 'off',
					manual: input.manual,
					actorId: input.actorId ?? null,
					trigger: input.trigger
				},
				deps
			);
			const candidate = summaryCall.text.trim();
			if (candidate && candidate.length <= 1_000) summary = candidate;
		} catch (caught) {
			// The summary is optional; keep the candidate without it.
			deps.log?.(
				'[ai] summary translation skipped: ' +
					(caught instanceof Error ? caught.message : String(caught))
			);
		}
	}

	// Glossary misses are advisory: they ride with the candidate so the drawer
	// can show them, and never fail a run that passed the deterministic checks.
	if (glossary.entries.length > 0) {
		input.onGlossaryMisses?.(verifyGlossary(glossary.entries, content));
	}

	return {
		title,
		content,
		summary,
		contentFormat: source.contentFormat,
		sourceHash: currentHash,
		provider: translated.provider,
		model: translated.model
	};
}
