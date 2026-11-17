/**
 * tableBudget returns the worst-case width an admin list table gets at a given viewport.
 * Reason: Tailwind breakpoints measure the viewport, but the table only gets what the
 * admin shell leaves over, and the shell subtracts a collapsible sidebar (16rem
 * expanded, 3rem collapsed, out of flow below 768px) — a set that fits at 767px is
 * over budget at 768px, where the sidebar takes 256px back.
 * Symptom: the title column was crushed to 6px and painted over its neighbour (the
 * "标题g" overlap).
 * The constants assume the sidebar expanded (the worst case); `list-budget.test.ts`
 * checks every page's tiers against them.
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
