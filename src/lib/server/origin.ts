import { env } from '$env/dynamic/private';

/**
 * Absolute-URL origin for feeds and robots.txt (P3-b detail pack #7; the
 * deploy batch pins the canonical host). Trailing slashes are stripped so
 * callers can concatenate paths directly.
 */
export function getOrigin(): string {
	const origin = env.ORIGIN;
	if (!origin) throw new Error('ORIGIN is not set');
	return origin.replace(/\/+$/, '');
}
