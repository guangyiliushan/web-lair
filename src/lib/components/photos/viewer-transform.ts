/**
 * Overlay viewer transform state machine (plan §5.3 layer 2; Q13 table).
 * Pure and DOM-free: the component owns the elements, this module owns the
 * numbers. Scale is fit=1 (the image always starts fitted); pan bounds are
 * derived from the scaled content size against the viewport.
 *
 * Coordinate frame: `x`/`y` are CSS-pixel offsets applied as
 * `translate3d(x, y, 0) scale(s)` about the viewport centre. Pointer inputs
 * are given in viewport-relative CENTRE coordinates (0,0 = centre) so the
 * zoom-at-pointer maths stays frame-agnostic; the component converts.
 */
export interface ViewerTransform {
	scale: number;
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

/** Scale range (Q13). */
export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
/** Wheel step per notch and keyboard +/- step (Q13). */
export const WHEEL_FACTOR = 1.15;
export const KEY_FACTOR = 1.5;
/** Double-click target scale (Q13: 1x <-> 2x). */
export const DOUBLE_TAP_SCALE = 2;
/** Swipe-down closes only at fit scale and past this distance (Q13). */
export const SWIPE_CLOSE_MAX_SCALE = 1.05;
export const SWIPE_CLOSE_MIN_PX = 80;
/** "Is it zoomed" threshold deciding navigate-vs-pan (Q13). */
const ZOOM_EPSILON = 0.01;

export function identity(): ViewerTransform {
	return { scale: MIN_SCALE, x: 0, y: 0 };
}

export function clampScale(scale: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Unzoomed (≈fit) gestures navigate; zoomed gestures pan (Q13). */
export function isZoomed(transform: ViewerTransform): boolean {
	return transform.scale > MIN_SCALE + ZOOM_EPSILON;
}

/**
 * Hard pan clamp (Q13): the scaled content may never leave the viewport
 * centre-frame bounds; when the scaled content is smaller than the viewport
 * on an axis, that axis locks to 0.
 */
export function clampPan(
	transform: ViewerTransform,
	viewport: Size,
	content: Size
): ViewerTransform {
	const maxX = Math.max(0, (content.width * transform.scale - viewport.width) / 2);
	const maxY = Math.max(0, (content.height * transform.scale - viewport.height) / 2);
	/** Clamp one axis; normalize -0 so state comparisons stay canonical. */
	const clampAxis = (value: number, max: number): number => {
		const clamped = Math.min(max, Math.max(-max, value));
		return clamped === 0 ? 0 : clamped;
	};
	return {
		scale: transform.scale,
		x: clampAxis(transform.x, maxX),
		y: clampAxis(transform.y, maxY)
	};
}

/** Reset to fit (Q13: `0` key and the double-click way back). */
export function reset(): ViewerTransform {
	return identity();
}

/**
 * Zoom by `factor` keeping the point under the pointer fixed (Q13: wheel
 * at pointer / double-click at pointer). Pointer coords are viewport-relative
 * centre coords - the same frame as x/y. Result is pan-clamped.
 */
export function zoomAt(
	transform: ViewerTransform,
	factor: number,
	pointer: { x: number; y: number },
	viewport: Size,
	content: Size
): ViewerTransform {
	const next = clampScale(transform.scale * factor);
	if (next === transform.scale) return transform;
	const ratio = next / transform.scale;
	return clampPan(
		{
			scale: next,
			x: pointer.x - (pointer.x - transform.x) * ratio,
			y: pointer.y - (pointer.y - transform.y) * ratio
		},
		viewport,
		content
	);
}

/** One wheel notch: up zooms in, down zooms out (Q13 ×1.15 per notch). */
export function wheelZoom(
	transform: ViewerTransform,
	deltaY: number,
	pointer: { x: number; y: number },
	viewport: Size,
	content: Size
): ViewerTransform {
	return zoomAt(
		transform,
		deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR,
		pointer,
		viewport,
		content
	);
}

/** +/- keys zoom around the viewport centre (Q13 ×1.5). */
export function keyZoom(
	transform: ViewerTransform,
	direction: 1 | -1,
	viewport: Size,
	content: Size
): ViewerTransform {
	const factor = direction === 1 ? KEY_FACTOR : 1 / KEY_FACTOR;
	return zoomAt(transform, factor, { x: 0, y: 0 }, viewport, content);
}

/** Double click: fit -> 2x at the pointer; any zoom -> reset (Q13 1x <-> 2x). */
export function toggleDoubleClick(
	transform: ViewerTransform,
	pointer: { x: number; y: number },
	viewport: Size,
	content: Size
): ViewerTransform {
	if (isZoomed(transform)) return reset();
	return zoomAt(identity(), DOUBLE_TAP_SCALE, pointer, viewport, content);
}

/** Drag delta while zoomed; unzoomed drags are navigation gestures (Q13). */
export function panBy(
	transform: ViewerTransform,
	dx: number,
	dy: number,
	viewport: Size,
	content: Size
): ViewerTransform {
	if (!isZoomed(transform)) return transform;
	return clampPan(
		{ scale: transform.scale, x: transform.x + dx, y: transform.y + dy },
		viewport,
		content
	);
}

/** Swipe-down close predicate: fit scale (≤1.05) and downward ≥80px (Q13). */
export function shouldCloseOnSwipe(transform: ViewerTransform, deltaYDown: number): boolean {
	return transform.scale <= SWIPE_CLOSE_MAX_SCALE && deltaYDown >= SWIPE_CLOSE_MIN_PX;
}
