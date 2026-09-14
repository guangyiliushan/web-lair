// Client entry: pin the app locale to Chinese until per-user locale
// switching ships (admin i18n audit phase A2). Paraglide's default strategy
// falls back to baseLocale (en), which would make aria-labels drift from the
// still-hard-coded Chinese UI text.
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'zh-cn');
