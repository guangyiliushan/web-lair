import { describe, expect, it, vi } from 'vitest';
import {
	createRobotsOracle,
	evaluateRobots,
	matchRobotsRules,
	parseRobots,
	type RobotsFetchOutcome
} from './robots';

const TOKEN = 'web-lair-link-check';

describe('robots parse (§2.2)', () => {
	it('parses groups, merges consecutive user-agent lines, ignores comments and stray fields', () => {
		const file = parseRobots(
			[
				'# header comment',
				'User-agent: a',
				'User-Agent: b',
				'Disallow: /x',
				'Sitemap: https://example.com/sitemap.xml',
				'user-agent: c # inline comment',
				'allow: /x/ok'
			].join('\r\n')
		);
		expect(file.groups).toHaveLength(2);
		expect(file.groups[0].agents).toEqual(['a', 'b']);
		expect(file.groups[0].rules).toEqual([{ allow: false, pattern: '/x' }]);
		expect(file.groups[1].agents).toEqual(['c']);
		expect(file.groups[1].rules).toEqual([{ allow: true, pattern: '/x/ok' }]);
	});

	it('ignores empty patterns and rules before any user-agent', () => {
		const file = parseRobots(['Disallow: /early', 'User-agent: *', 'Disallow:'].join('\n'));
		expect(file.groups).toHaveLength(1);
		expect(file.groups[0].rules).toEqual([]);
	});

	it('strips a BOM on the first line', () => {
		const file = parseRobots('\uFEFFUser-agent: *\nDisallow: /bom');
		expect(file.groups[0].rules).toEqual([{ allow: false, pattern: '/bom' }]);
	});
});

describe('robots matching (§2.2.1/§2.2.2)', () => {
	it('prefers the longest matching agent value and merges same-value groups', () => {
		const file = parseRobots(
			[
				'User-agent: web-lair',
				'Disallow: /a',
				'User-agent: web-lair-link-check',
				'Disallow: /b',
				'User-agent: web-lair-link-check',
				'Disallow: /c',
				'User-agent: *',
				'Disallow: /all'
			].join('\n')
		);
		const rules = matchRobotsRules(file, TOKEN);
		expect(rules).toEqual([
			{ allow: false, pattern: '/b' },
			{ allow: false, pattern: '/c' }
		]);
	});

	it('falls back to the wildcard group; no groups at all = no rules (null)', () => {
		const wildcard = parseRobots('User-agent: *\nDisallow: /all');
		expect(matchRobotsRules(wildcard, TOKEN)).toEqual([{ allow: false, pattern: '/all' }]);
		const other = parseRobots('User-agent: someotherbot\nDisallow: /x');
		expect(matchRobotsRules(other, TOKEN)).toBeNull();
	});

	it('evaluates paths: prefix, wildcard, $ anchor, allow-tie and most-specific', () => {
		const rules = [
			{ allow: false, pattern: '/' },
			{ allow: true, pattern: '/p' },
			{ allow: false, pattern: '/*.php$' },
			{ allow: false, pattern: '/exact$' }
		];
		expect(evaluateRobots(rules, '/page').allowed).toBe(true); // allow /p more specific
		expect(evaluateRobots(rules, '/other').allowed).toBe(false);
		expect(evaluateRobots(rules, '/a/b.php').allowed).toBe(false); // /*.php$ longest match
		// `$` anchors: a query suffix stops /*.php$ from matching; the
		// blanket `/` disallow then applies.
		expect(evaluateRobots(rules, '/a/b.php?x=1').allowed).toBe(false);
		// In isolation the same URL has no matching rule at all (allowed).
		expect(evaluateRobots([{ allow: false, pattern: '/*.php$' }], '/a/b.php?x=1').allowed).toBe(
			true
		);
		expect(evaluateRobots([{ allow: false, pattern: '/*.php$' }], '/a/b.php').allowed).toBe(false);
		expect(evaluateRobots(rules, '/exact').allowed).toBe(false); // $ anchors
		expect(evaluateRobots(rules, '/exact/sub').allowed).toBe(false); // falls to disallow /
		expect(
			evaluateRobots(
				[
					{ allow: true, pattern: '/x' },
					{ allow: false, pattern: '/x' }
				],
				'/x'
			).allowed
		).toBe(true); // tie -> allow
		expect(evaluateRobots(null, '/anything').allowed).toBe(true);
		expect(evaluateRobots([], '/anything').allowed).toBe(true);
	});
});

describe('robots oracle (§4.7)', () => {
	const rulesText = 'User-agent: *\nDisallow: /blocked';

	function oracleWith(outcome: RobotsFetchOutcome | (() => Promise<RobotsFetchOutcome>)) {
		const fetchRobots = vi.fn(typeof outcome === 'function' ? outcome : async () => outcome);
		const oracle = createRobotsOracle({ productToken: TOKEN, fetchRobots });
		return { oracle, fetchRobots };
	}

	it('200 parses rules and disallows matching paths', async () => {
		const { oracle } = oracleWith({
			outcome: 'text',
			status: 200,
			body: new TextEncoder().encode(rulesText)
		});
		expect((await oracle.decisionFor(new URL('https://site.example/blocked/x'))).kind).toBe(
			'disallow'
		);
		expect((await oracle.decisionFor(new URL('https://site.example/free'))).kind).toBe('allow');
	});

	it('memoizes per origin (one fetch for many URLs)', async () => {
		const { oracle, fetchRobots } = oracleWith({
			outcome: 'text',
			status: 200,
			body: new TextEncoder().encode('')
		});
		await oracle.decisionFor(new URL('https://site.example/a'));
		await oracle.decisionFor(new URL('https://site.example/b'));
		expect(fetchRobots).toHaveBeenCalledTimes(1);
		await oracle.decisionFor(new URL('https://other.example/a'));
		expect(fetchRobots).toHaveBeenCalledTimes(2);
	});

	it('4xx (except 429) = no restrictions; 429/5xx = unreachable; network/redirect = no restrictions', async () => {
		const notFound = oracleWith({ outcome: 'text', status: 404, body: new Uint8Array() });
		expect((await notFound.oracle.decisionFor(new URL('https://a.example/x'))).kind).toBe('allow');

		const tooMany = oracleWith({ outcome: 'text', status: 429, body: new Uint8Array() });
		expect((await tooMany.oracle.decisionFor(new URL('https://a.example/x'))).kind).toBe(
			'unreachable'
		);

		const serverError = oracleWith({ outcome: 'text', status: 503, body: new Uint8Array() });
		expect((await serverError.oracle.decisionFor(new URL('https://a.example/x'))).kind).toBe(
			'unreachable'
		);

		// Transport failures fall through to the page fetch (2026-10-06
		// refinement): a network-dead site must count as a hard failure.
		const network = oracleWith({ outcome: 'network-error', message: 'connect ECONNREFUSED' });
		expect((await network.oracle.decisionFor(new URL('https://a.example/x'))).kind).toBe('allow');

		// Redirect overflow takes the unavailable path, with a distinguishable reason.
		const overflow = oracleWith({ outcome: 'redirect-loop' });
		const overflowDecision = await overflow.oracle.decisionFor(new URL('https://a.example/x'));
		expect(overflowDecision.kind).toBe('allow');
		expect(overflowDecision.reason).toContain('redirect overflow');
	});

	it('thrown fetch errors fall through to allow, not crashes', async () => {
		const { oracle } = oracleWith(async () => {
			throw new Error('boom');
		});
		expect((await oracle.decisionFor(new URL('https://a.example/x'))).kind).toBe('allow');
	});
});

describe('robots hardening + Google precedence (review batch 2026-10-06)', () => {
	it('Google ties: /page vs /*.ph on /page.php5 -> allow; /*.htm (longer) wins on /page.htm', () => {
		expect(
			evaluateRobots(
				[
					{ allow: true, pattern: '/page' },
					{ allow: false, pattern: '/*.ph' }
				],
				'/page.php5'
			).allowed
		).toBe(true);
		expect(
			evaluateRobots(
				[
					{ allow: true, pattern: '/page' },
					{ allow: false, pattern: '/*.htm' }
				],
				'/page.htm'
			).allowed
		).toBe(false);
	});

	it('pathological wildcard patterns complete fast (linear matcher, no ReDoS)', () => {
		const started = Date.now();
		const result = evaluateRobots(
			[{ allow: false, pattern: '/*a*a*a*a*a*a*b' }],
			`/${'a'.repeat(400)}`
		);
		expect(result.allowed).toBe(true);
		expect(Date.now() - started).toBeLessThan(200);
	});

	it('percent-encoding: raw UTF-8 patterns match %-encoded URIs; unreserved %-bytes decode', () => {
		expect(evaluateRobots([{ allow: false, pattern: '/foo/ツ' }], '/foo/%E3%83%84').allowed).toBe(
			false
		);
		expect(evaluateRobots([{ allow: false, pattern: '/foo/baz' }], '/foo/%62%61%7A').allowed).toBe(
			false
		);
	});

	it('user-agent values with a version tail still match (googlebot/1.2 = googlebot)', () => {
		const rules = matchRobotsRules(
			parseRobots('user-agent: web-lair-link-check/0.0.1\ndisallow: /x'),
			TOKEN
		);
		expect(rules).toEqual([{ allow: false, pattern: '/x' }]);
	});
});
