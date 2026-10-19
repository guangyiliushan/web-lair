/**
 * Canonical email normalization (RFC 5322 practical subset).
 *
 * Kept as a leaf module so both the subscription service and the suppression
 * list hash the same canonical string. Two normalization rules would create
 * hashes that can never match, i.e. an opt-out that silently does not suppress.
 */
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string | null {
	const email = raw.trim().toLowerCase();
	if (email.length === 0 || email.length > EMAIL_MAX) return null;
	if (!EMAIL_RE.test(email)) return null;
	return email;
}
