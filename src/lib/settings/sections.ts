/**
 * The eight settings sections in navigation order (decision register §3K).
 *
 * Lives outside `$lib/server` on purpose: the settings layout is a component
 * that also runs in the browser, and SvelteKit refuses to import a server
 * module into client code. The server-side tier map keys off this same list.
 */
export const SETTINGS_SECTIONS = [
	'profile',
	'site',
	'content',
	'notifications',
	'integrations',
	'storage',
	'ai',
	'account'
] as const;

export type SettingSection = (typeof SETTINGS_SECTIONS)[number];
