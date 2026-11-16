import { getPublicOrigin } from '$lib/server/origin';
import { getOption } from '$lib/server/config/options-registry';
import type { RequestHandler } from './$types';

/**
 * Dynamic robots.txt: ORIGIN drives the Sitemap line, the request origin is the
 * dev fallback. Deliberately minimal — admin and account pages are protected by
 * auth, not by robots (Google: robots.txt is not an access-control mechanism).
 * The AI policy groups are voluntary signals (RFC 9309 §1), not access control;
 * product tokens change over time, so the lists live here.
 */
const AI_ANSWER_ENGINES = ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot'];
const AI_TRAINING = ['GPTBot', 'Google-Extended', 'CCBot', 'ClaudeBot'];

export const GET: RequestHandler = async ({ url }) => {
	const origin = getPublicOrigin() ?? url.origin;
	const crawl = await getOption('ai.crawl');
	const lines = ['User-agent: *', 'Allow: /', '', `Sitemap: ${origin}/sitemap.xml`, ''];
	for (const [goal, tokens, enabled] of [
		['answer-engine', AI_ANSWER_ENGINES, crawl.answerEngine],
		['training', AI_TRAINING, crawl.training]
	] as const) {
		lines.push(
			`# AI ${goal}: ${enabled ? 'allowed' : 'disallowed'} (voluntary; not access control)`
		);
		for (const token of tokens) lines.push(`User-agent: ${token}`);
		lines.push(enabled ? 'Allow: /' : 'Disallow: /', '');
	}
	const body = lines.join('\n');

	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'public, max-age=300'
		}
	});
};
