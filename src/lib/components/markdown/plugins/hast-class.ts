import type { Element } from 'hast';

/** Normalised class list for a hast element (handles array and string forms). */
export function classList(element: Element): string[] {
	// `className` is typed as `string[]` by @types/hast, but HAST coming from
	// other sources can carry the string form too — keep the runtime guard and
	// let TS narrow from `unknown`.
	const value: unknown = element.properties?.className;
	if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
	return Array.isArray(value) ? value.map(String) : [];
}

/** Adds a class once; leaves the properties untouched when already present. */
export function addClass(element: Element, name: string): void {
	const list = classList(element);
	if (list.includes(name)) return;
	element.properties = { ...element.properties, className: [...list, name] };
}
