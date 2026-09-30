import { execFileSync } from 'node:child_process';
import type { Page, Response } from '@playwright/test';

/**
 * Shared acceptance-test plumbing (comment P3a review follow-up): the docker
 * psql shim, the Valkey helpers and the rate-gated auth API post were copied
 * between e2e/comment-p3a.e2e.ts and e2e/admin-2fa.e2e.ts - and had already
 * drifted (the comment version grew a 429 retry the 2FA version lacked). One
 * home for both specs so they cannot drift again.
 */
export const ORIGIN = 'http://localhost:4173';

export function psql(sql: string): string {
	return execFileSync(
		'docker',
		['exec', '-i', 'web-lair-db-1', 'psql', '-U', 'root', '-d', 'local', '-tAc', sql],
		{ encoding: 'utf8' }
	).trim();
}

/** Throttle keys live in Valkey; drop them best-effort (container may be down). */
export function valkeyDel(key: string) {
	try {
		execFileSync('docker', ['exec', 'web-lair-valkey-1', 'valkey-cli', 'DEL', key], {
			encoding: 'utf8'
		});
	} catch {
		// fail-open by contract: no Valkey means the limiter was never engaged.
	}
}

export function valkeyAlive(): boolean {
	try {
		return (
			execFileSync('docker', ['exec', 'web-lair-valkey-1', 'valkey-cli', 'PING'], {
				encoding: 'utf8'
			})
				.trim()
				.toUpperCase() === 'PONG'
		);
	} catch {
		return false;
	}
}

/**
 * better-auth's rate limiter is ACTIVE in the production preview and, without
 * a resolvable client IP, keys buckets by path alone: /sign-in*|/sign-up*|
 * /change-* allow 3 per rolling 10s and /two-factor/* 3 per 10s (probed: the
 * 4th rapid call answers 429 + X-Retry-After). Pace those calls with the same
 * rule, and retry once on a 429 so parallel spec files cannot flake each
 * other (shared per-path bucket).
 */
const RATE_LIMITED = /^\/(sign-in|sign-up|change-password|change-email|two-factor)\//;
const RATE_WINDOW_MS = 10_500;
const RATE_MAX = 3;
const rateGates = new Map<string, { count: number; last: number }>();

export async function apiPost(
	page: Page,
	path: string,
	data: Record<string, unknown>,
	attempt = 0
): Promise<Response> {
	const apiPath = path.replace(/^\/api\/auth/, '');
	if (RATE_LIMITED.test(apiPath)) {
		const now = Date.now();
		const state = rateGates.get(apiPath) ?? { count: 0, last: 0 };
		if (now - state.last >= RATE_WINDOW_MS) {
			state.count = 0;
		} else if (state.count >= RATE_MAX) {
			// The limiter resets after a >=10s idle gap from the last request.
			await new Promise((resolve) => setTimeout(resolve, RATE_WINDOW_MS - (now - state.last)));
			state.count = 0;
		}
		state.count += 1;
		state.last = Date.now();
		rateGates.set(apiPath, state);
	}
	const response = await page.request.post(path, { data, headers: { origin: ORIGIN } });
	if (response.status() === 429 && attempt < 2) {
		const retryAfter = Number(response.headers()['x-retry-after'] ?? 11);
		await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
		return apiPost(page, path, data, attempt + 1);
	}
	return response;
}
