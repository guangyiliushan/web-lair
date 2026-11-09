import { createHash } from 'node:crypto';
import { redirect } from '@sveltejs/kit';
import { locales } from '$lib/paraglide/runtime';
import { getOption } from '$lib/server/config/options-registry';
import { buildLlmsTxt } from '$lib/server/llms';
import { getPublicOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';

function localeFromPath(pathname: string): (typeof locales)[number] | null {
	const first = pathname.split('/').filter(Boolean)[0];
	return (locales as readonly string[]).includes(first)
		? (first as (typeof locales)[number])
		: null;
}

export const GET: RequestHandler = async ({ url }) => {
	const lang = localeFromPath(url.pathname);
	if (!lang) {
		const defaultLang = await getOption('site.default_lang');
		redirect(302, `/${defaultLang}/llms.txt`);
	}
	const enabled = (await getOption('site.languages')).enabled as readonly string[];
	if (!enabled.includes(lang)) return new Response('Not found', { status: 404 });
	const origin = getPublicOrigin() ?? url.origin;
	const body = await buildLlmsTxt(origin, lang);
	const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'cache-control': 'public, max-age=300',
			etag
		}
	});
};
