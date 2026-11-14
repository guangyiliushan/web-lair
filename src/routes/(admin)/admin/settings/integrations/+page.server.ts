import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { requireAdminRole } from '$lib/server/authz';

/**
 * Planned/read-only capability map for Integrations (W10.1; decision register
 * §3G). Only the GitHub rich cards have a real consumer (`GITHUB_TOKEN` in the
 * embed-meta endpoint); nothing on this page writes, so the load reports the
 * one real status fact and the page renders groups only - never a token input,
 * a toggle or a Save button.
 *
 * The token is read here as a boolean: the value never reaches the client.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
	return { githubConfigured: Boolean(env.GITHUB_TOKEN?.trim()) };
};
