import type { RequestHandler } from './$types';
import { handleFaviconRequest } from '$lib/server/favicon-proxy';

export const GET: RequestHandler = ({ url }) => handleFaviconRequest(url);
