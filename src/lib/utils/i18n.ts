import { getLocale } from '$lib/paraglide/runtime';

const CACHE = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>();

function getDTF(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `dtf:${locale}:${JSON.stringify(options)}`;
	if (CACHE.has(key)) return CACHE.get(key) as Intl.DateTimeFormat;
	const formatter = new Intl.DateTimeFormat(locale, options);
	CACHE.set(key, formatter);
	return formatter;
}

function getRTF(locale: string): Intl.RelativeTimeFormat {
	const key = `rtf:${locale}`;
	if (CACHE.has(key)) return CACHE.get(key) as Intl.RelativeTimeFormat;
	const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
	CACHE.set(key, formatter);
	return formatter;
}

/** Intl forbids mixing `dateStyle` with individual date components. */
const DATE_COMPONENT_KEYS = ['weekday', 'era', 'year', 'month', 'day'] as const;

function hasDateComponents(options?: Intl.DateTimeFormatOptions): boolean {
	return options !== undefined && DATE_COMPONENT_KEYS.some((key) => options[key] !== undefined);
}

export function formatDate(date: Date | number, options?: Intl.DateTimeFormatOptions): string {
	const locale = getLocale();
	// When the caller picks components (e.g. { month, day }) they define the
	// format; otherwise default to the long date style.
	const resolved: Intl.DateTimeFormatOptions = hasDateComponents(options)
		? { ...options }
		: { dateStyle: 'long', ...options };
	return getDTF(locale, resolved).format(date);
}

export function formatDateTime(date: Date | number, options?: Intl.DateTimeFormatOptions): string {
	const locale = getLocale();
	return getDTF(locale, { dateStyle: 'long', timeStyle: 'short', ...options }).format(date);
}

export function formatNumber(num: number, options?: Intl.NumberFormatOptions): string {
	const locale = getLocale();
	const key = `nf:${locale}:${JSON.stringify(options ?? {})}`;
	if (CACHE.has(key)) return (CACHE.get(key) as Intl.NumberFormat).format(num);
	const formatter = new Intl.NumberFormat(locale, options);
	CACHE.set(key, formatter);
	return formatter.format(num);
}

export function formatCurrency(
	amount: number,
	currency: string,
	options?: Intl.NumberFormatOptions
): string {
	const locale = getLocale();
	return new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(amount);
}

export function formatRelativeTime(date: Date | number): string {
	const locale = getLocale();
	const now = Date.now();
	const diff = now - (typeof date === 'number' ? date : date.getTime());
	const rtf = getRTF(locale);

	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (Math.abs(seconds) < 60) {
		const rounded = -Math.round(seconds / 10) * 10 || -1;
		return rtf.format(rounded, 'second');
	}
	if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
	if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour');
	if (Math.abs(days) < 30) return rtf.format(-days, 'day');

	return formatDate(date);
}
