import { env } from '$env/dynamic/private';

export const ADMIN_BASE_PATH = '/admin';
const DEFAULT_ADMIN_LOGIN_SLUG = 'secure-9x7k2q';

function normalizeSlug(value: string | undefined, fallback: string): string {
	const normalized = value?.trim().replace(/^\/+|\/+$/g, '') ?? '';

	if (!normalized) {
		return fallback;
	}

	return normalized;
}

export interface AdminConfig {
	loginPath: string;
	loginSlug: string;
	setupToken: string;
}

export function getAdminConfig(): AdminConfig {
	const loginSlug = normalizeSlug(env.ADMIN_LOGIN_SLUG, DEFAULT_ADMIN_LOGIN_SLUG);
	const loginPath = `${ADMIN_BASE_PATH}/${loginSlug}/login`;

	return {
		loginPath,
		loginSlug,
		setupToken: env.ADMIN_SETUP_TOKEN?.trim() || ''
	};
}

export function safeAdminRedirectTarget(target: string | null | undefined): string {
	if (!target) {
		return ADMIN_BASE_PATH;
	}

	const trimmed = target.trim();
	if (!trimmed.startsWith(ADMIN_BASE_PATH)) {
		return ADMIN_BASE_PATH;
	}

	return trimmed;
}
