/**
 * H3 exclusions: customizations that change better-auth's own storage or
 * challenge semantics. They are rejected because the library's upgrade,
 * migration and recovery flows assume its own behaviour.
 *
 * Scanned by `scripts/auth-schema-guard.ts` and pinned by the unit test.
 */
export interface SourceFile {
	path: string;
	text: string;
}

export interface ForbiddenMatch {
	path: string;
	line: number;
	pattern: string;
}

interface ForbiddenPattern {
	label: string;
	regex: RegExp;
}

const FORBIDDEN: ForbiddenPattern[] = [
	{
		label: 'session-token hashing',
		regex:
			/(?:hash|sha256|createHash|scrypt|bcrypt)[^\n]{0,40}sessionToken|sessionToken[^\n]{0,40}(?:hash|sha256|createHash|scrypt|bcrypt)/i
	},
	{
		label: 'backup-code hashing',
		regex:
			/(?:hash|sha256|createHash|scrypt|bcrypt)[^\n]{0,40}backupCode|backupCode[^\n]{0,40}(?:hash|sha256|createHash|scrypt|bcrypt)/i
	},
	{
		label: 'custom 2FA challenge',
		regex: /twoFactor\s*\(\s*\{[\s\S]{0,400}?\bchallenge\s*:/
	},
	{
		label: 'custom adapter',
		regex: /\b(?:customAdapter|createAdapter|wrapAdapter)\b/
	}
];

export function scanForbiddenAuthCustomizations(files: readonly SourceFile[]): ForbiddenMatch[] {
	const matches: ForbiddenMatch[] = [];
	for (const file of files) {
		// The generated schema is output, not code: it may mention anything.
		if (file.path.endsWith('auth.schema.ts')) continue;
		// This module stores the patterns as data; scanning it would match its
		// own rule table.
		if (file.path.endsWith('auth-customization-guard.ts')) continue;
		for (const pattern of FORBIDDEN) {
			// One hit per file/pattern is enough to fail the gate; the message
			// points at the first line so the fix is obvious.
			const match = pattern.regex.exec(file.text);
			if (!match) continue;
			const line = file.text.slice(0, match.index).split('\n').length;
			matches.push({ path: file.path, line, pattern: pattern.label });
		}
	}
	return matches;
}
