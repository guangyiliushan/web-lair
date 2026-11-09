import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getOption } from '../config/options-registry.ts';
import { posts } from '../db/content/post.schema.ts';
import { runAiCall } from './client.ts';
import { AiError } from './errors.ts';
import { plainText, plainTextLength } from './protect.ts';
import type { AiDeps, AiTrigger } from './types.ts';

export const MAX_SUMMARY_SOURCE_CHARS = 24_000;
export const MAX_SUMMARY_CHARS = 600;

export interface SummaryCandidate {
	summary: string;
	sourceHash: string;
	provider: string;
	model: string;
	lang: string;
}

function cleanSummary(raw: string): string {
	let text = raw.trim();
	text = text.replace(/^```(?:markdown|md|text)?\s*/i, '').replace(/\s*```$/, '');
	text = plainText(text);
	text = text.replace(/\s+/g, ' ').trim();
	return text.slice(0, MAX_SUMMARY_CHARS);
}

export async function generateSummary(
	input: {
		postId: string;
		manual?: boolean;
		actorId?: string | null;
		trigger?: AiTrigger;
	},
	deps: AiDeps
): Promise<SummaryCandidate> {
	const [post] = await deps.db
		.select({
			id: posts.id,
			title: posts.title,
			content: posts.content,
			summary: posts.summary,
			lang: posts.lang
		})
		.from(posts)
		.where(eq(posts.id, input.postId))
		.limit(1);
	if (!post) throw new AiError('bad_request', 'Post not found');
	if (!(post.content ?? '').trim()) throw new AiError('bad_request', 'Post body is empty');

	const options = await getOption('ai.summary', deps.db);
	if (plainTextLength(post.content ?? '') < options.minChars) {
		throw new AiError(
			'bad_request',
			`Post is shorter than the summary threshold (${options.minChars})`
		);
	}
	const body = (post.content ?? '').slice(0, MAX_SUMMARY_SOURCE_CHARS);
	const system = [
		`Write a concise summary of the post in ${post.lang}.`,
		'Use 1-3 sentences, plain text only. Use only facts stated in the post; do not add claims, links or markdown.',
		'Output only the summary.'
	].join('\n');
	const call = await runAiCall(
		{
			task: 'summary',
			functionSlot: 'summary',
			system,
			user: `Title: ${post.title}\n\n${body}`,
			relatedType: 'post',
			relatedId: post.id,
			maxOutputTokens: 400,
			temperature: 0.2,
			thinking: 'off',
			manual: input.manual,
			actorId: input.actorId ?? null,
			trigger: input.trigger
		},
		deps
	);
	const summary = cleanSummary(call.text);
	if (!summary) throw new AiError('invalid_output', 'Summary is empty');
	return {
		summary,
		sourceHash: createHash('sha256')
			.update(JSON.stringify([post.title, post.content ?? '']))
			.digest('hex'),
		provider: call.provider,
		model: call.model,
		lang: post.lang
	};
}
