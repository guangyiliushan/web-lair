/**
 * robots.txt for the links checker (plan §4.7, implementable clauses decided
 * 2026-10-06). References: RFC 9309 (§2.2.1 user-agent matching, §2.2.2
 * allow/disallow semantics + percent-encoding, §2.2.3 special characters
 * `#`/`$`/`*`, §2.3.1.x access results, §2.4 caching, §2.5 size) and
 * Google's interpretation page.
 *
 * Status semantics honored by the oracle: 2xx parse; 4xx (except 429) treat
 * as "no restrictions"; 429/5xx -> site skipped this round (kind `robots`,
 * not counted). RFC 9309 §2.3.1.4's "MUST assume complete disallow" text
 * covers "server or network errors" BOTH - the deliberate deviation for
 * transport-level failures (they fall through to the page fetch so a
 * network-dead site still counts as the hard failure it is, §4.3; no extra
 * requests are made) is ruled in plan §4.7 and recorded in §9 v1.2.1;
 * redirect overflow takes the §2.3.1.2/§2.3.1.3 "unavailable" -> no
 * restrictions path.
 *
 * Path evaluation uses a LINEAR wildcard matcher (segment scanning, no
 * regex): a hostile robots.txt pattern like `*a*a*a*a*a*b` must not trigger
 * catastrophic backtracking in the drain's single thread (CWE-1333). Both
 * the rule and the URI are canonicalized symmetrically (canonicalPath():
 * raw UTF-8 -> %XX, existing escape hex upper-cased, percent-encoded
 * unreserved characters decoded), per RFC §2.2.2 and Google's
 * canonicalization note.
 */

export class RobotsDisallowedError extends Error {
	// Explicit assignments: parameter properties break Node's strip-only
	// TypeScript mode (the builtin runs under plain `node`).
	readonly rule: string;

	constructor(rule: string) {
		super(`robots.txt disallows: ${rule}`);
		this.name = 'RobotsDisallowedError';
		this.rule = rule;
	}
}

export class RobotsUnreachableError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`robots.txt unavailable: ${reason}`);
		this.name = 'RobotsUnreachableError';
		this.reason = reason;
	}
}

export interface RobotsRule {
	allow: boolean;
	pattern: string;
}

export interface RobotsGroup {
	agents: string[];
	rules: RobotsRule[];
}

export interface RobotsFile {
	groups: RobotsGroup[];
}

/**
 * RFC 9309 §2.1/§2.2 group parser. Field names are case-insensitive;
 * everything after `#` is a comment; a new group starts at the first
 * user-agent line and at every user-agent line that follows a rule line;
 * other records (sitemap, crawl-delay, ...) are ignored and do NOT break a
 * group (Google's grouping example).
 */
export function parseRobots(text: string): RobotsFile {
	const groups: RobotsGroup[] = [];
	let current: RobotsGroup | null = null;
	let afterAgentLine = false;
	for (const rawLine of text.split(/\r\n|\r|\n/)) {
		const line = rawLine.startsWith('\uFEFF') ? rawLine.slice(1) : rawLine;
		const commentAt = line.indexOf('#');
		const body = (commentAt >= 0 ? line.slice(0, commentAt) : line).trim();
		if (!body) continue;
		const separator = body.indexOf(':');
		if (separator < 0) continue;
		const field = body.slice(0, separator).trim().toLowerCase();
		const value = body.slice(separator + 1).trim();
		if (field === 'user-agent') {
			if (!current || !afterAgentLine) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			afterAgentLine = true;
		} else if (field === 'allow' || field === 'disallow') {
			if (!current) continue;
			afterAgentLine = false;
			if (!value) continue; // empty patterns are ignored (RFC §2.2.2)
			current.rules.push({ allow: field === 'allow', pattern: value });
		}
	}
	return { groups };
}

/**
 * `googlebot/1.2` and `googlebot*` are equivalent to `googlebot` (Google's
 * user-agent notes): strip a trailing `*` run and a `/version` tail.
 */
function canonicalAgent(value: string): string {
	return value.replace(/\*+$/, '').split('/')[0];
}

/**
 * RFC 9309 §2.2.1: case-insensitive matching against the product token; the
 * most specific (longest) matching user-agent value wins and all groups with
 * that exact value are merged; when nothing matches, the `*` groups apply;
 * otherwise no rules (null = unrestricted).
 */
export function matchRobotsRules(file: RobotsFile, productToken: string): RobotsRule[] | null {
	const token = productToken.toLowerCase();
	let bestValue: string | null = null;
	for (const group of file.groups) {
		for (const agent of group.agents) {
			const value = canonicalAgent(agent);
			if (!value) continue; // `*` or empty value
			if (token.includes(value) && (bestValue === null || value.length > bestValue.length)) {
				bestValue = value;
			}
		}
	}
	if (bestValue !== null) {
		const chosen = bestValue;
		return file.groups
			.filter((group) => group.agents.some((agent) => canonicalAgent(agent) === chosen))
			.flatMap((group) => group.rules);
	}
	const wildcard = file.groups.filter((group) =>
		group.agents.some((agent) => canonicalAgent(agent) === '')
	);
	return wildcard.length > 0 ? wildcard.flatMap((group) => group.rules) : null;
}

/**
 * RFC 9309 §2.2.2 path evaluation with Google's precedence clarification:
 * rules match from the first octet; the most specific rule wins - where
 * "most specific" is the length of the RULE PATH (trailing `*` ignored;
 * Google's "Order of precedence for rules" table: `/page` vs `/*.ph` on
 * `/page.php5` is a TIE and the least restrictive (allow) rule applies,
 * unlike naive matched-URI-length logic); equal-length allow beats
 * disallow; no match = allowed.
 */
export function evaluateRobots(
	rules: RobotsRule[] | null,
	uri: string
): { allowed: boolean; rule?: RobotsRule } {
	if (!rules || rules.length === 0) return { allowed: true };
	const target = canonicalPath(uri || '/');
	let bestLength = -1;
	let allowed = true;
	let matched: RobotsRule | undefined;
	for (const rule of rules) {
		const pattern = canonicalPath(rule.pattern);
		if (!wildcardMatch(pattern, target)) continue;
		const length = specificity(pattern);
		if (length > bestLength) {
			bestLength = length;
			allowed = rule.allow;
			matched = rule;
		} else if (length === bestLength && rule.allow) {
			allowed = true;
			matched = rule;
		}
	}
	return { allowed, rule: matched };
}

/** Linear wildcard matcher: `*` = any run, `$` = end anchor (no regex). */
function wildcardMatch(pattern: string, target: string): boolean {
	let body = pattern;
	let anchorEnd = false;
	if (body.endsWith('$')) {
		anchorEnd = true;
		body = body.slice(0, -1);
	}
	// A bare `$` (empty anchored body) can only match the empty path, which
	// never occurs; without this guard matchSegments(['']) would wave every
	// URI through (review batch 2026-10-06 - regression vs the pre-refactor
	// /^$/ behavior).
	if (anchorEnd && body === '') return target === '';
	const segments = body.split('*');
	const last = segments[segments.length - 1];
	if (anchorEnd && last !== '') {
		if (!target.endsWith(last)) return false;
		return matchSegments(segments.slice(0, -1), target.slice(0, target.length - last.length));
	}
	return matchSegments(segments, target);
}

function matchSegments(segments: string[], target: string): boolean {
	if (segments.length === 0) return true;
	if (!target.startsWith(segments[0])) return false;
	let position = segments[0].length;
	for (let index = 1; index < segments.length; index += 1) {
		const segment = segments[index];
		if (segment === '') continue;
		const found = target.indexOf(segment, position);
		if (found < 0) return false;
		position = found + segment.length;
	}
	return true;
}

/** Specificity = rule-path length, trailing `*` runs and `$` excluded. */
function specificity(pattern: string): number {
	let body = pattern;
	if (body.endsWith('$')) body = body.slice(0, -1);
	return body.replace(/\*+$/, '').length;
}

/** Raw non-ASCII characters are canonicalized to %XX UTF-8 form (§2.2.2). */
function encodeNonAscii(pattern: string): string {
	return pattern.replace(/[^\x21-\x7e]/g, (ch) => {
		let encoded = '';
		for (const byte of new TextEncoder().encode(ch)) {
			encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		}
		return encoded;
	});
}

/**
 * Percent-encoding canonicalization for one comparison side (review batch
 * 2026-10-06): raw non-ASCII -> %XX, existing escape hex upper-cased (URL
 * serialization preserves the author's case; Google treats raw and encoded
 * rule paths as identical) and percent-encoded unreserved characters
 * decoded. Applied to BOTH the rule and the URI so the comparison is
 * symmetric.
 */
function canonicalPath(value: string): string {
	return decodeUnreservedPercent(
		encodeNonAscii(value).replace(/%[0-9a-fA-F]{2}/g, (matched) => matched.toUpperCase())
	);
}

/** Percent-encoded unreserved characters are decoded before comparison (§2.2.2). */
function decodeUnreservedPercent(uri: string): string {
	return uri.replace(/%([0-9A-Fa-f]{2})/g, (match, hex: string) => {
		const ch = String.fromCharCode(Number.parseInt(hex, 16));
		return /[A-Za-z0-9\-._~]/.test(ch) ? ch : match;
	});
}

export interface RobotsDecision {
	kind: 'allow' | 'disallow' | 'unreachable';
	reason: string;
}

export type RobotsFetchOutcome =
	| { outcome: 'text'; status: number; body: Uint8Array }
	| { outcome: 'network-error'; message: string }
	| { outcome: 'redirect-loop' };

export interface RobotsOracleOptions {
	productToken: string;
	/** Wired to the fetch unit (512 KiB cap, SSRF-pinned, no robots gate). */
	fetchRobots: (robotsUrl: string) => Promise<RobotsFetchOutcome>;
}

export interface RobotsOracle {
	decisionFor(url: URL): Promise<RobotsDecision>;
}

type RobotsBase =
	| { kind: 'rules'; rules: RobotsRule[] | null }
	| { kind: 'allow-all'; reason?: string }
	| { kind: 'unreachable'; reason: string };

/**
 * Per-run memo (plan §4.7): one robots.txt fetch per (scheme, host, port);
 * no persistence - the 24 h run cadence already equals the practical cache
 * lifetime (RFC §2.4 / Google: "up to 24 hours").
 */
export function createRobotsOracle(options: RobotsOracleOptions): RobotsOracle {
	const memo = new Map<string, Promise<RobotsBase>>();

	function baseFor(origin: string): Promise<RobotsBase> {
		let entry = memo.get(origin);
		if (!entry) {
			entry = load(origin);
			memo.set(origin, entry);
		}
		return entry;
	}

	async function load(origin: string): Promise<RobotsBase> {
		let outcome: RobotsFetchOutcome;
		try {
			outcome = await options.fetchRobots(`${origin}/robots.txt`);
		} catch {
			// A thrown fetcher is our own bug: never let it silently freeze the
			// site forever - fall through to the page fetch instead.
			return { kind: 'allow-all' };
		}
		// Transport failures are NOT a skip (2026-10-06 refinement, plan
		// §9 v1.2.1): a network-dead site is the hard failure the checker
		// exists to detect, so fall through to the normal page fetch (which
		// classifies it; no extra requests). Redirect overflow is the
		// §2.3.1.2/§2.3.1.3 "unavailable" -> no restrictions path.
		if (outcome.outcome === 'redirect-loop') {
			return { kind: 'allow-all', reason: 'redirect overflow (treated as unavailable)' };
		}
		if (outcome.outcome === 'network-error') {
			return { kind: 'allow-all' };
		}
		const { status, body } = outcome;
		if (status === 429 || status >= 500) return { kind: 'unreachable', reason: `http ${status}` };
		if (status >= 400) return { kind: 'allow-all' };
		const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
		return { kind: 'rules', rules: matchRobotsRules(parseRobots(text), options.productToken) };
	}

	return {
		async decisionFor(url: URL): Promise<RobotsDecision> {
			const base = await baseFor(url.origin);
			if (base.kind === 'allow-all') {
				return { kind: 'allow', reason: base.reason ?? 'robots.txt absent' };
			}
			if (base.kind === 'unreachable') return { kind: 'unreachable', reason: base.reason };
			const uri = `${url.pathname}${url.search}`;
			const { allowed, rule } = evaluateRobots(base.rules, uri);
			if (allowed) return { kind: 'allow', reason: 'allowed' };
			return {
				kind: 'disallow',
				reason: rule ? `${rule.allow ? 'allow' : 'disallow'}: ${rule.pattern}` : 'disallowed'
			};
		}
	};
}
