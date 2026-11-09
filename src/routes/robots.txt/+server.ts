import { getPublicOrigin } from '$lib/server/origin';
import { getOption } from '$lib/server/config/options-registry';
import type { RequestHandler } from './$types';

/**
 * Dynamic robots.txt (P3-b, ledger §22): ORIGIN is the single source for
 * the Sitemap line, with a request-origin fallback in dev (review finding).
 * Minimal by design — crawl management only; admin and account pages are
 * protected by auth, not by robots (Google: robots.txt is not a mechanism
 * for keeping a page out of the index).
 *
 * The two AI policy groups are voluntary signals, not access control
 * (RFC 9309 §1). Product tokens change over time; keep the lists here.
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
