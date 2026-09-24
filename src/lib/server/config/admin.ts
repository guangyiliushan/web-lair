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
	twoFactorPath: string;
	setupToken: string;
}

/**
 * True for the admin base path itself and anything below it.
 * A bare `startsWith('/admin')` would also match unrelated routes such as
 * `/administrator`.
 */
export function isAdminPath(pathname: string): boolean {
	return pathname === ADMIN_BASE_PATH || pathname.startsWith(`${ADMIN_BASE_PATH}/`);
}

export function getAdminConfig(): AdminConfig {
	const loginSlug = normalizeSlug(env.ADMIN_LOGIN_SLUG, DEFAULT_ADMIN_LOGIN_SLUG);
	const loginPath = `${ADMIN_BASE_PATH}/${loginSlug}/login`;

	return {
		loginPath,
		loginSlug,
		twoFactorPath: `${ADMIN_BASE_PATH}/${loginSlug}/two-factor`,
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
