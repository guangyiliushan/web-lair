import { describe, expect, it } from 'vitest';
import {
	PRICE_MAX,
	formatPrice,
	markManualEdits,
	parsePriceText,
	parsePricingForm,
	pricingFromRows,
	rowsFromPricing,
	splitKey
} from './pricing';

/**
 * The pricing editor round-trip. What matters here is that a save can never
 * quietly drop a price (an unpriced call is indistinguishable from "never
 * configured" and silently disables the budget) and can never accept a number
 * the budget ledger cannot trust.
 */

const form = (rows: { key: string; input?: string; output?: string; chars?: string }[]) => ({
	keys: rows.map((row) => row.key),
	inputPer1M: rows.map((row) => row.input ?? ''),
	outputPer1M: rows.map((row) => row.output ?? ''),
	per1MChars: rows.map((row) => row.chars ?? '')
});

describe('splitKey', () => {
	it('splits on the first slash so a model id may contain one', () => {
		expect(splitKey('DeepSeek/deepseek-flash')).toEqual({
			provider: 'DeepSeek',
			model: 'deepseek-flash'
		});
		expect(splitKey('openrouter/vendor/model')).toEqual({
			provider: 'openrouter',
			model: 'vendor/model'
		});
	});

	it('rejects a key without both halves', () => {
		expect(splitKey('deepseek-flash')).toBeNull();
		expect(splitKey('/model')).toBeNull();
		expect(splitKey('provider/')).toBeNull();
	});
});

describe('formatPrice', () => {
	it('prints the shortest honest form', () => {
		expect(formatPrice(0.15)).toBe('0.15');
		expect(formatPrice(1)).toBe('1');
		expect(formatPrice(1.98)).toBe('1.98');
		expect(formatPrice(undefined)).toBe('');
	});

	it('keeps up to six decimals and drops the noise', () => {
		expect(formatPrice(0.0000004)).toBe('0');
		expect(formatPrice(0.003)).toBe('0.003');
	});
});

describe('parsePriceText', () => {
	it('treats blank as "no price on this axis"', () => {
		expect(parsePriceText('')).toEqual({ kind: 'empty' });
		expect(parsePriceText('   ')).toEqual({ kind: 'empty' });
	});

	it('accepts plain and grouped decimals', () => {
		expect(parsePriceText('0.15')).toEqual({ kind: 'value', value: 0.15 });
		expect(parsePriceText('1,234.5')).toEqual({ kind: 'value', value: 1234.5 });
		// A lone comma is the decimal separator in zh-cn / ja input habits.
		expect(parsePriceText('0,15')).toEqual({ kind: 'value', value: 0.15 });
	});

	it('rejects anything the budget cannot trust', () => {
		for (const raw of ['-1', 'abc', '1e5', '0.1.2', '12%', String(PRICE_MAX + 1)]) {
			expect(parsePriceText(raw), raw).toEqual({ kind: 'invalid' });
		}
	});

	it('rounds to six decimals instead of storing float noise', () => {
		expect(parsePriceText('0.12345678')).toEqual({ kind: 'value', value: 0.123457 });
	});
});

describe('parsePricingForm', () => {
	it('rebuilds the option from the submitted rows', () => {
		const result = parsePricingForm(
			form([
				{ key: 'DeepSeek/deepseek-flash', input: '0.15', output: '0.6' },
				{ key: 'DeepL/quality', chars: '20' }
			])
		);
		expect(result).toEqual({
			ok: true,
			pricing: {
				'DeepSeek/deepseek-flash': { inputPer1M: 0.15, outputPer1M: 0.6 },
				'DeepL/quality': { per1MChars: 20 }
			}
		});
	});

	it('drops a row whose three cells are all blank, so clearing a price works', () => {
		const result = parsePricingForm(
			form([{ key: 'DeepSeek/deepseek-flash' }, { key: 'DeepSeek/deepseek-v4-pro', input: '0.66' }])
		);
		expect(result).toEqual({
			ok: true,
			pricing: { 'DeepSeek/deepseek-v4-pro': { inputPer1M: 0.66 } }
		});
	});

	it('fails the whole save instead of silently dropping a bad cell', () => {
		const result = parsePricingForm(
			form([
				{ key: 'DeepSeek/deepseek-flash', input: '0.15' },
				{ key: 'DeepSeek/deepseek-v4-pro', output: 'lots' }
			])
		);
		expect(result).toEqual({ ok: false, errors: { 1: 'outputPer1M' } });
	});

	it('reports the row index of a malformed key', () => {
		const result = parsePricingForm(
			form([
				{ key: 'DeepSeek/deepseek-flash', input: '1' },
				{ key: 'no-slash', input: '2' }
			])
		);
		expect(result).toEqual({ ok: false, errors: { 1: 'key' } });
	});

	it('rejects the same key twice', () => {
		const result = parsePricingForm(
			form([
				{ key: 'DeepSeek/deepseek-flash', input: '1' },
				{ key: 'DeepSeek/deepseek-flash', input: '2' }
			])
		);
		expect(result).toEqual({ ok: false, errors: { 1: 'duplicate' } });
	});

	it('tolerates a missing cell array (no-JS clients omit empty fields)', () => {
		const result = parsePricingForm({
			keys: ['DeepSeek/deepseek-flash'],
			inputPer1M: ['0.15'],
			outputPer1M: [],
			per1MChars: []
		});
		expect(result).toEqual({
			ok: true,
			pricing: { 'DeepSeek/deepseek-flash': { inputPer1M: 0.15 } }
		});
	});
});

describe('rowsFromPricing', () => {
	it('sorts the rows so the editor order is stable across saves', () => {
		const rows = rowsFromPricing({
			'B/model': { inputPer1M: 1 },
			'A/model': { outputPer1M: 2 }
		});
		expect(rows.map((row) => row.key)).toEqual(['A/model', 'B/model']);
	});

	it('round-trips through pricingFromRows', () => {
		const pricing = {
			'A/x': { inputPer1M: 0.15, outputPer1M: 0.6, source: 'catalog' as const }
		};
		expect(pricingFromRows(rowsFromPricing(pricing))).toEqual(pricing);
	});
});

describe('markManualEdits', () => {
	const current = {
		'A/x': { inputPer1M: 1, outputPer1M: 2, source: 'catalog' as const },
		'B/y': { inputPer1M: 3, source: 'manual' as const }
	};

	it('keeps a synced entry synced while its numbers are untouched', () => {
		const next = { 'A/x': { inputPer1M: 1, outputPer1M: 2 } };
		expect(markManualEdits(next, current)).toEqual({
			'A/x': { inputPer1M: 1, outputPer1M: 2, source: 'catalog' }
		});
	});

	it('stamps an edited value as manual', () => {
		const next = { 'A/x': { inputPer1M: 1, outputPer1M: 9 } };
		expect(markManualEdits(next, current)['A/x'].source).toBe('manual');
	});

	it('stamps a brand-new row as manual', () => {
		const next = { 'C/z': { inputPer1M: 5 } };
		expect(markManualEdits(next, current)['C/z'].source).toBe('manual');
	});
});
