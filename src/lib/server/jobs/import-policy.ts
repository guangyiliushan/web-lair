/**
 * Job import policy: the single source shared by the save gate
 * (`save-gate.ts`) and the repo eslint config (builtin jobs block).
 * Two negations: minimatch `*` never crosses "/", so bare `node:*` needs a
 * second negation covering one-slash builtins like `node:fs/promises`;
 * `!#jobs-sdk` is wildcard-free so lookalikes (`evil#jobs-sdk`,
 * `#jobs-sdk-x`, `x#jobs-sdk`) stay restricted.
 * `no-restricted-imports` only sees STATIC imports, so the selectors
 * reject dynamic imports with a disallowed string-literal specifier and
 * any dynamic import with a non-literal specifier (computed specifiers
 * cannot be verified against the allowlist). Asymmetry: the runtime gate
 * accepts no-substitution template literals while the selectors stay
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
