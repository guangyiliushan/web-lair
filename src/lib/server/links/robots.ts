/**
 * robots.txt for the links checker (plan §4.7, implementable clauses decided
 * 2026-10-06). References: RFC 9309 (§2.2.1 user-agent matching, §2.2.2
 * allow/disallow semantics, §2.2.3 special characters `#`/`$`/`*`, §2.3.1.x
 * access results, §2.4 caching, §2.5 size) and Google's interpretation page.
 *
 * Status semantics honored by the oracle: 2xx parse; 4xx (except 429) treat
 * as "no restrictions"; 429/5xx -> site skipped this round (kind `robots`,
 * not counted - RFC 9309 §2.3.1.4's "MUST assume complete disallow" covers
 * server status codes); transport-level failures (DNS/connect/TLS/timeout)
 * or redirect overflow -> "unavailable" -> no restrictions
 * (RFC §2.3.1.2/§2.3.1.3), because for a verifier a network-dead site must
 * surface as the hard failure it is (§4.3) - the page fetch classifies it
 * with no extra requests (2026-10-06 execution refinement).
 */

export class RobotsDisallowedError extends Error {
	constructor(readonly rule: string) {
		super(`robots.txt disallows: ${rule}`);
		this.name = 'RobotsDisallowedError';
	}
}

export class RobotsUnreachableError extends Error {
	constructor(readonly reason: string) {
		super(`robots.txt unavailable: ${reason}`);
		this.name = 'RobotsUnreachableError';
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
			const value = agent.replace(/\*+$/, '');
			if (!value) continue; // `*` or empty value
			if (token.includes(value) && (bestValue === null || value.length > bestValue.length)) {
				bestValue = value;
			}
		}
	}
	if (bestValue !== null) {
		const chosen = bestValue;
		return file.groups
			.filter((group) => group.agents.some((agent) => agent.replace(/\*+$/, '') === chosen))
			.flatMap((group) => group.rules);
	}
	const wildcard = file.groups.filter((group) =>
		group.agents.some((agent) => agent === '*' || agent.replace(/\*+$/, '') === '')
	);
	return wildcard.length > 0 ? wildcard.flatMap((group) => group.rules) : null;
}

/**
 * RFC 9309 §2.2.2 path evaluation: rules match from the first octet, the
 * most specific (longest matched URI prefix) rule wins, and an equal-length
 * allow beats a disallow; no match = allowed.
 */
export function evaluateRobots(
	rules: RobotsRule[] | null,
	uri: string
): { allowed: boolean; rule?: RobotsRule } {
	if (!rules || rules.length === 0) return { allowed: true };
	const target = uri || '/';
	let bestLength = -1;
	let allowed = true;
	let matched: RobotsRule | undefined;
	for (const rule of rules) {
		const regex = ruleRegex(rule.pattern);
		if (!regex) continue;
		const match = regex.exec(target);
		if (!match) continue;
		const length = match[0].length;
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

/** `*` = any characters, `$` = end anchor; everything else escaped (§2.2.3). */
function ruleRegex(pattern: string): RegExp | null {
	let body = pattern;
	let anchorEnd = false;
	if (body.endsWith('$')) {
		anchorEnd = true;
		body = body.slice(0, -1);
	}
	const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : `\\${ch}`));
	try {
		return new RegExp(`^${escaped}${anchorEnd ? '$' : ''}`);
	} catch {
		return null;
	}
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
	| { kind: 'allow-all' }
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
		// Transport failures are NOT a skip (2026-10-06 refinement): the
		// RFC's MUST covers server status codes; a network-dead site is the
		// hard failure the checker exists to detect, so fall through to the
		// normal page fetch (which classifies it; no extra requests).
		if (outcome.outcome === 'redirect-loop' || outcome.outcome === 'network-error') {
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
			if (base.kind === 'allow-all') return { kind: 'allow', reason: 'robots.txt absent' };
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
