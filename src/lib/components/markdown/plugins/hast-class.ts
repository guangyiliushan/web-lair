import type { Element } from 'hast';

/** Normalised class list for a hast element (handles array and string forms). */
export function classList(element: Element): string[] {
	const value = element.properties?.className;
	return Array.isArray(value)
		? value.map(String)
		: typeof value === 'string'
			? value.split(/\s+/).filter(Boolean)
			: [];
}

/** Adds a class once; leaves the properties untouched when already present. */
export function addClass(element: Element, name: string): void {
	const list = classList(element);
	if (list.includes(name)) return;
	element.properties = { ...element.properties, className: [...list, name] };
}
