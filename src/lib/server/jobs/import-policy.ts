/**
 * Job import policy is the single source shared by the save gate (web path,
 * `save-gate.ts`) and the repository eslint config (builtin jobs block).
 *
 * Why two node negations: minimatch never crosses "/" with a single `*`, so
 * one-slash builtins such as `node:fs/promises` need a second one-slash pattern
 * on top of the bare `node:*` negation.
 *
 * Why `!#jobs-sdk` is exact: a wildcard-free glob matches that string alone, so
 * lookalikes (`evil#jobs-sdk`, `#jobs-sdk-x`, `x#jobs-sdk`) stay restricted; a
 * trailing-wildcard negation admitted those forms while the runtime gate kept
 * rejecting them (`#jobs-sdk/x` was restricted both ways).
 *
 * Why the dynamic selectors: `no-restricted-imports` only sees STATIC import
 * statements, so `await import('lodash')` slips through. The selectors reject
 * dynamic imports with a disallowed string-literal specifier, and any dynamic
 * import whose specifier is not a literal (a computed specifier cannot be
 * verified against the allowlist).
 * Known asymmetry (registered nit): the runtime gate accepts no-substitution
 * template literals while the selectors stay stricter for builtins; computed
 * templates are rejected on both sides.
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
