import { describe, expect, it } from 'vitest';
import { sanitizeLanguage } from '$lib/components/markdown/toolbar/code-languages';

// Locks the fence info-token contract: whatever the user types, the result
// must be a single token the editor's own code importer accepts
// (CODE_START_REGEX reads `[\w-]` after the fence), so the language can never
// spill into the code body on the next load.
describe('sanitizeLanguage', () => {
	it('keeps only characters the importer accepts', () => {
		const adversarial = [
			'a b`c',
			'js```\n# pwned',
			'C++',
			'c#',
			'a.b',
			'a+b',
			'"><script>alert(1)</script>',
			'我',
			'```',
			'   ',
			''
		];
		for (const input of adversarial) {
			expect(sanitizeLanguage(input), JSON.stringify(input)).toMatch(/^[A-Za-z0-9_-]*$/);
		}
	});

	it('trims, caps at 32 characters and never invents content', () => {
		expect(sanitizeLanguage('  ts  ')).toBe('ts');
		expect(sanitizeLanguage('a'.repeat(64))).toHaveLength(32);
		expect(sanitizeLanguage('```')).toBe('');
		expect(sanitizeLanguage('我')).toBe('');
		expect(sanitizeLanguage('C++')).toBe('C');
	});
});
