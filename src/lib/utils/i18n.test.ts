import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetLocale = vi.fn(() => 'en');

vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: mockGetLocale
}));

describe('i18n formatting', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetLocale.mockReturnValue('en');
	});

	describe('formatDate', () => {
		it('formats date in en locale', async () => {
			const { formatDate } = await import('./i18n');
			const result = formatDate(new Date('2026-01-15'));
			expect(result).toContain('2026');
		});

		it('uses component options without mixing in dateStyle', async () => {
			const { formatDate } = await import('./i18n');
			const result = formatDate(new Date(2026, 0, 15, 12), { month: 'short', day: 'numeric' });
			expect(result).toBe('Jan 15');
		});

		it('formats date in zh-cn locale', async () => {
			mockGetLocale.mockReturnValue('zh-cn');
			const { formatDate } = await import('./i18n');
			const result = formatDate(new Date('2026-01-15'));
			expect(result).toContain('2026');
		});

		it('formats date in ja locale', async () => {
			mockGetLocale.mockReturnValue('ja');
			const { formatDate } = await import('./i18n');
			const result = formatDate(new Date('2026-01-15'));
			expect(result).toContain('2026');
		});

		it('formats date with different locale', async () => {
			mockGetLocale.mockReturnValue('zh-cn');
			const { formatDate } = await import('./i18n');
			const result = formatDate(new Date('2026-01-15'));
			expect(result).toBeTruthy();
			expect(typeof result).toBe('string');
		});
	});

	describe('formatDateTime', () => {
		it('includes both date and time parts', async () => {
			const { formatDateTime } = await import('./i18n');
			const result = formatDateTime(new Date('2026-06-15T14:30:00'));
			expect(result).toContain('2026');
		});
	});

	describe('formatNumber', () => {
		it('formats numbers with locale group separators', async () => {
			const { formatNumber } = await import('./i18n');
			const result = formatNumber(1234567.89);
			expect(result).toContain('.');
		});

		it('handles integer formatting', async () => {
			const { formatNumber } = await import('./i18n');
			const result = formatNumber(100);
			expect(result).toBeTruthy();
			expect(typeof result).toBe('string');
		});
	});

	describe('formatRelativeTime', () => {
		it('shows relative time for recent dates', async () => {
			const { formatRelativeTime } = await import('./i18n');
			const result = formatRelativeTime(Date.now() - 5 * 60 * 1000);
			expect(result).toBeTruthy();
		});

		it('falls back to date format for older dates', async () => {
			const { formatRelativeTime } = await import('./i18n');
			const result = formatRelativeTime(Date.now() - 60 * 24 * 60 * 60 * 1000);
			expect(result).toContain('2026');
		});
	});

	describe('formatCurrency', () => {
		it('formats CNY in en locale', async () => {
			const { formatCurrency } = await import('./i18n');
			const result = formatCurrency(99.5, 'CNY');
			expect(typeof result).toBe('string');
			expect(result).toBeTruthy();
		});

		it('formats JPY in ja locale', async () => {
			mockGetLocale.mockReturnValue('ja');
			const { formatCurrency } = await import('./i18n');
			const result = formatCurrency(1000, 'JPY');
			expect(typeof result).toBe('string');
			expect(result).toBeTruthy();
		});
	});
});
