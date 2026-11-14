import { describe, expect, it } from 'vitest';
import { auditChanges, redactAuditPayload } from './activity';

describe('redactAuditPayload', () => {
	it('redacts secret-shaped keys at every depth but keeps key_version', () => {
		expect(
			redactAuditPayload({
				fields: ['display_name', 'header_label'],
				before: { display_name: 'old', key_version: 2 },
				after: {
					display_name: 'new',
					token: 'sk-live-123',
					nested: { password: 'hunter2', safe: 'ok' }
				}
			})
		).toEqual({
			fields: ['display_name', 'header_label'],
			before: { display_name: 'old', key_version: 2 },
			after: {
				display_name: 'new',
				token: '[redacted]',
				nested: { password: '[redacted]', safe: 'ok' }
			}
		});
	});

	it('returns null for a missing or non-object payload', () => {
		expect(redactAuditPayload(null)).toBeNull();
		expect(redactAuditPayload('text')).toBeNull();
		expect(redactAuditPayload(['a'])).toBeNull();
	});
});

describe('auditChanges', () => {
	it('joins fields with before/after and caps long values', () => {
		expect(
			auditChanges({
				fields: ['display_name', 'links'],
				before: { display_name: 'old' },
				after: {
					display_name: 'new',
					links: [{ platform: 'github', href: 'https://github.com/x' }]
				}
			})
		).toEqual([
			{ field: 'display_name', before: 'old', after: 'new' },
			{
				field: 'links',
				before: '—',
				after: '[{"platform":"github","href":"https://github.com/x"}]'
			}
		]);
	});

	it('handles an absent payload', () => {
		expect(auditChanges(null)).toEqual([]);
	});
});
