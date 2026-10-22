/**
 * Width budget for the admin list tables.
 *
 * Tailwind breakpoints look at the **viewport**, but the table is only as wide
 * as what the admin shell leaves over — and the shell subtracts a sidebar the
 * user can collapse (16rem expanded, 3rem collapsed, and out of flow entirely
 * on narrow screens). A column set that fits at 767px of viewport can be over
 * budget at 768px, where the sidebar suddenly takes 256px back.
 *
 * That mismatch is what crushed the title column to 6px and painted it over its
 * neighbour (the "标题g" overlap). The numbers below are measured against the
 * sidebar **expanded** — the worst case — and every page's tiers are checked
 * against them by `list-budget.test.ts`.
 *
 * Measured (2026-10-22, sidebar expanded): V=640 -> 592, V=768 -> 454,
 * V=800 -> 486, V=1440 -> 1110. The formula below is deliberately a little
 * conservative at every one of those points.
 */

/** Expanded sidebar + shell padding + scrollbar, at desktop widths. */
const CHROME_DESKTOP = 335;
/** Shell padding + scrollbar while the sidebar is out of flow. */
const CHROME_NARROW = 48;
/** Below this the sidebar no longer sits beside the content. */
const SIDEBAR_IN_FLOW = 768;

/** Worst-case width the table actually gets at a given viewport. */
export function tableBudget(viewport: number): number {
	return viewport - (viewport >= SIDEBAR_IN_FLOW ? CHROME_DESKTOP : CHROME_NARROW);
}

/**
 * Viewports worth asserting at. Tier boundaries plus the either side of the
 * 768px dip, where the budget falls off a cliff.
 */
export const BUDGET_SAMPLES = [
	320, 375, 480, 639, 640, 767, 768, 1023, 1024, 1279, 1280, 1536
] as const;

/** Tailwind spacing scale: `w-28` -> 28 * 4px. */
export function tailwindPx(token: string): number {
	const match = /^(?:min-w-|w-)(\d+)$/.exec(token.trim());
	if (!match) throw new Error(`not a Tailwind width token: ${token}`);
	return Number(match[1]) * 4;
}
