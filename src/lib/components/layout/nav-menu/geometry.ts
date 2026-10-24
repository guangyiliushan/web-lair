/**
 * Shared panel geometry for the dense nav panels (home / posts / notes).
 *
 * All three sit on `w-[520px]` and must agree on the split: the eye tracks the
 * divider while the pointer moves between nav items, so a per-panel column
 * width reads as the whole panel jumping. These are inlined rather than written
 * as Tailwind arbitrary values so the components and the e2e width assertions
 * cannot drift apart — that drift is exactly how the right column collapsed to
 * `0px` in the first place.
 */

/** 520 panel − 2px border − 8px `p-1`. */
export const NAV_PANEL_CONTENT_W = 510;

/**
 * Left column width. 176 leaves 168px after the `pe-2`, which fits a category
 * name plus its count badge without truncating (`Notes on tools` ≈ 88px at
 * 12px + 24px badge + 12px row padding), and gives the home panel's `text-2xl`
 * figures room for five digits beside their label.
 */
export const NAV_COL_PRIMARY_W = 176;

/** Right column = whatever is left. */
export const NAV_COL_SECONDARY_W = NAV_PANEL_CONTENT_W - NAV_COL_PRIMARY_W;

export function navGridColumns(): string {
	return `${NAV_COL_PRIMARY_W}px minmax(0, 1fr)`;
}

/**
 * Fixed panel height.
 *
 * 165 does not fit: the shortest panel (home) needs 175 once `border` + `p-1`
 * are counted. 176 is the next round number that holds every panel, with the
 * row caps below keeping the tall ones inside it — all five land at 176–178,
 * so the panel does not change size as the pointer moves between nav items.
 */
export const NAV_PANEL_HEIGHT = 176;

/** Rows per list column. 4/4 is what makes the two columns the same height. */
export const NAV_ROWS_PER_COL = 4;

/** Home page grid: 2 columns × 4 rows. */
export const NAV_HOME_GRID_MAX = NAV_ROWS_PER_COL * 2;
