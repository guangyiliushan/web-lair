import { describe, expect, it } from 'vitest';
import {
	DOUBLE_TAP_SCALE,
	KEY_FACTOR,
	MAX_SCALE,
	MIN_SCALE,
	WHEEL_FACTOR,
	clampPan,
	clampScale,
	identity,
	isZoomed,
	keyZoom,
	panBy,
	reset,
	shouldCloseOnSwipe,
	toggleDoubleClick,
	wheelZoom,
	zoomAt,
	type ViewerTransform
} from './viewer-transform';

/** 1600x900 viewport, 800x600 content fitted at scale 1. */
const VIEWPORT = { width: 1600, height: 900 };
const CONTENT = { width: 800, height: 600 };

describe('viewer transform state machine (Q13)', () => {
	it('clamps scale into [1, 8]', () => {
		expect(clampScale(0.2)).toBe(MIN_SCALE);
		expect(clampScale(3)).toBe(3);
		expect(clampScale(99)).toBe(MAX_SCALE);
	});

	it('flags zoomed above the navigate/pan threshold', () => {
		expect(isZoomed(identity())).toBe(false);
		expect(isZoomed({ scale: 1.005, x: 0, y: 0 })).toBe(false);
		expect(isZoomed({ scale: 1.02, x: 0, y: 0 })).toBe(true);
	});

	it('keeps the point under the pointer fixed while zooming', () => {
		// 2000x600 content: at 2x maxX = (4000-1600)/2 = 1200, so the
		// pointer-anchored offset (-100) survives unclamped.
		const wide = { width: 2000, height: 600 };
		const zoomed = zoomAt(identity(), 2, { x: 100, y: 0 }, VIEWPORT, wide);
		expect(zoomed).toEqual({ scale: 2, x: -100, y: 0 });
	});

	it('pins an axis to 0 once the scaled content fits that axis', () => {
		// 800x600 at 2x = 1600x1200: maxX = 0 (pinned), maxY = 150.
		const zoomed = zoomAt(identity(), 2, { x: 100, y: 0 }, VIEWPORT, CONTENT);
		expect(zoomed).toEqual({ scale: 2, x: 0, y: 0 });
	});

	it('locks an axis to 0 when the scaled content is smaller than the viewport', () => {
		// 800x600 content at 2x = 1600x1200: x max 0, y max (1200-900)/2 = 150.
		const clamped = clampPan({ scale: 2, x: 999, y: 999 }, VIEWPORT, CONTENT);
		expect(clamped.x).toBe(0);
		expect(clamped.y).toBe(150);
	});

	it('wheel zooms in up / out down by 1.15 per notch', () => {
		const inOne = wheelZoom(identity(), -100, { x: 0, y: 0 }, VIEWPORT, CONTENT);
		expect(inOne.scale).toBeCloseTo(WHEEL_FACTOR, 6);
		const out = wheelZoom(inOne, 100, { x: 0, y: 0 }, VIEWPORT, CONTENT);
		expect(out.scale).toBeCloseTo(1, 6);
	});

	it('wheel never crosses the scale bounds', () => {
		let transform: ViewerTransform = identity();
		for (let i = 0; i < 50; i += 1) {
			transform = wheelZoom(transform, -100, { x: 0, y: 0 }, VIEWPORT, CONTENT);
		}
		expect(transform.scale).toBe(MAX_SCALE);
		for (let i = 0; i < 50; i += 1) {
			transform = wheelZoom(transform, 100, { x: 0, y: 0 }, VIEWPORT, CONTENT);
		}
		expect(transform.scale).toBe(MIN_SCALE);
	});

	it('+/- keys zoom around the centre by 1.5', () => {
		const plus = keyZoom(identity(), 1, VIEWPORT, CONTENT);
		expect(plus.scale).toBeCloseTo(KEY_FACTOR, 6);
		expect(plus.x).toBe(0);
		expect(plus.y).toBe(0);
		const minus = keyZoom(plus, -1, VIEWPORT, CONTENT);
		expect(minus.scale).toBeCloseTo(1, 6);
	});

	it('double click toggles fit <-> 2x at the pointer', () => {
		const zoomed = toggleDoubleClick(identity(), { x: 50, y: 25 }, VIEWPORT, CONTENT);
		expect(zoomed.scale).toBe(DOUBLE_TAP_SCALE);
		expect(zoomed).not.toEqual(identity());
		const back = toggleDoubleClick(zoomed, { x: 50, y: 25 }, VIEWPORT, CONTENT);
		expect(back).toEqual(identity());
	});

	it('pan only moves a zoomed transform and stays clamped', () => {
		const fitted = panBy(identity(), 40, 40, VIEWPORT, CONTENT);
		expect(fitted).toEqual(identity());
		// 3x: content 2400x1800 -> maxX 400, maxY 450.
		const zoomed = { scale: 3, x: 0, y: 0 };
		expect(panBy(zoomed, 500, -500, VIEWPORT, CONTENT)).toEqual({ scale: 3, x: 400, y: -450 });
	});

	it('reset returns to fit', () => {
		expect(reset()).toEqual(identity());
	});

	it('pins the scale envelope with literals (constants cannot drift silently)', () => {
		expect(clampScale(999)).toBe(8);
		expect(clampScale(0.1)).toBe(1);
		expect(toggleDoubleClick(identity(), { x: 0, y: 0 }, VIEWPORT, CONTENT).scale).toBe(2);
	});

	it('swipe-down closes only at fit scale and strictly past 80px (Q13 wording)', () => {
		expect(shouldCloseOnSwipe(identity(), 81)).toBe(true);
		expect(shouldCloseOnSwipe(identity(), 80)).toBe(false);
		expect(shouldCloseOnSwipe(identity(), 79)).toBe(false);
		// Scale 1.05 still closes; 1.06 does not (Q13 threshold).
		expect(shouldCloseOnSwipe({ scale: 1.05, x: 0, y: 0 }, 100)).toBe(true);
		expect(shouldCloseOnSwipe({ scale: 1.06, x: 0, y: 0 }, 100)).toBe(false);
	});
});
