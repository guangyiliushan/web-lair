import { describe, expect, it } from 'vitest';
import { OWNER_STATUS_DEFAULT } from './owner-status';
import {
	firstGrapheme,
	ownerNameLength,
	ownerNameTier,
	ownerPresenceFromStatus
} from './owner-presence';

describe('owner presence view model', () => {
	it('classifies owner names by grapheme count (R-5: short <= 6)', () => {
		expect(ownerNameTier('Lair')).toBe('short');
		expect(ownerNameTier('mikoto')).toBe('short');
		expect(ownerNameTier('Web Lair')).toBe('medium');
		expect(ownerNameTier('guangyiliushan')).toBe('long');
		expect(ownerNameTier('一二三四五')).toBe('short');
		expect(ownerNameTier('一二三四五六')).toBe('short');
		expect(ownerNameTier('一二三四五六七')).toBe('medium');
		expect(ownerNameLength('👨‍👩‍👧‍👦')).toBe(1);
	});

	it('takes the first grapheme for avatar fallbacks', () => {
		expect(firstGrapheme('guangyiliushan')).toBe('g');
		expect(firstGrapheme('山田')).toBe('山');
		expect(firstGrapheme('👨‍👩‍👧‍👦 family')).toBe('👨‍👩‍👧‍👦');
		expect(firstGrapheme('   ')).toBe('?');
	});

	it('maps the static setting to unknown, never online/offline', () => {
		const presence = ownerPresenceFromStatus(OWNER_STATUS_DEFAULT);
		expect(presence).toEqual({
			state: 'unknown',
			activity: null,
			app: null,
			updatedAt: null,
			lastSeenAt: null
		});

		const disabled = ownerPresenceFromStatus({ ...OWNER_STATUS_DEFAULT, enabled: false });
		expect(disabled.state).toBe('unknown');
	});
});
