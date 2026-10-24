import { describe, expect, it } from 'vitest';
import { OWNER_STATUS_DEFAULT } from './owner-status';
import { ownerNameLength, ownerNameTier, ownerPresenceFromStatus } from './owner-presence';

describe('owner presence view model', () => {
	it('classifies owner names by grapheme count', () => {
		expect(ownerNameTier('Lair')).toBe('short');
		expect(ownerNameTier('Web Lair')).toBe('medium');
		expect(ownerNameTier('guangyiliushan')).toBe('long');
		expect(ownerNameTier('一二三四五')).toBe('short');
		expect(ownerNameLength('👨‍👩‍👧‍👦')).toBe(1);
	});

	it('adapts the static setting into the preview shape', () => {
		const presence = ownerPresenceFromStatus(OWNER_STATUS_DEFAULT);
		expect(presence).toEqual({
			state: 'online',
			activity: 'coding',
			app: { name: 'VS Code', icon: '' },
			updatedAt: null,
			lastSeenAt: null
		});
	});
});
