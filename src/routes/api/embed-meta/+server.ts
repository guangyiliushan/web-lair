import type { RequestHandler } from './$types';
import { handleEmbedMetaRequest } from '$lib/server/embed-meta';
import { env } from '$env/dynamic/private';

export const prerender = false;

export const GET: RequestHandler = ({ url }) =>
	handleEmbedMetaRequest(url, { token: env.GITHUB_TOKEN || undefined });
