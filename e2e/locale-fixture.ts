// The zh-cn message set, pinned explicitly per spec. The app's own default is
// the project base locale (en): the client-side getLocale() pin that used to
// force zh-cn was removed with the locale-switch fix (it made the persisted
// preference and the resolved locale disagree, which reloaded forever). Specs
// that assert Chinese copy pin it for themselves instead of relying on it
// globally; the language-switcher spec switches away from it on purpose.
export const zhCnLocale = {
	storageState: {
		cookies: [
			{
				name: 'PARAGLIDE_LOCALE',
				value: 'zh-cn',
				domain: 'localhost',
				path: '/',
				expires: -1,
				// Playwright 1.60 types require these three on a storageState
				// cookie even though the runtime defaults them.
				httpOnly: false,
				secure: false,
				sameSite: 'Lax'
			}
		],
		origins: []
	}
};
