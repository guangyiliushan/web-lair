/**
 * Job import policy - the single source shared by the save gate (web path,
 * `save-gate.ts`) and the repository eslint config (builtin jobs block). The
 * J-2 review round found the literals duplicated; this module ends the drift.
 *
 * Why the two node negations: minimatch never crosses "/" with a single `*`,
 * so one-slash builtins such as node:fs/promises need a second one-slash
 * pattern on top of the bare `node:*` negation (probed matrix, 2026-10-07).
 *
 * Why `!#jobs-sdk` is exact (J-2 review round 2, D3): a glob without
 * wildcards matches that string alone, so lookalikes (`evil#jobs-sdk`,
 * `#jobs-sdk-x`, `x#jobs-sdk`) stay restricted - the earlier `!*#jobs-sdk*`
 * negation admitted those forms (probed) while the runtime gate kept
 * rejecting them. (`#jobs-sdk/x` was already restricted then and now.)
 *
 * Why the dynamic selectors: `no-restricted-imports` only sees STATIC import
 * statements; `await import('lodash')` slips through it (J-2 review F3). The
 * selectors below reject dynamic imports whose specifier is a disallowed
 * string literal, and any dynamic import whose specifier is not a literal at
 * all (a computed specifier cannot be verified against the allowlist).
 * Known asymmetry (registered nit): the runtime gate accepts no-substitution
 * template literals (compile-time constants), while the selector above stays
 * stricter for builtins; computed templates are rejected on both sides.
 */
export const JOB_IMPORT_PATTERNS = [
	{
		group: ['**', '!node:*', '!node:*/*', '!#jobs-sdk'],
		message: 'only node:* modules and #jobs-sdk may be imported'
	}
];

export const JOB_DYNAMIC_IMPORT_SELECTORS = [
	{
		selector: 'ImportExpression > Literal[value=/^(?!node:|#jobs-sdk$)/]',
		message: 'dynamically imported modules must be node:* or #jobs-sdk'
	},
	{
		selector: 'ImportExpression > :not(Literal)',
		message: 'dynamic import specifiers must be string literals (node:* or #jobs-sdk)'
	}
];

/** Allowed specifier forms (mirrors the pattern group above). */
export function isAllowedImportSpecifier(specifier: string): boolean {
	return specifier.startsWith('node:') || specifier === '#jobs-sdk';
}
