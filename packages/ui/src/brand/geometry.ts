/** One master of the Cursor mark, drawn in a 24-unit viewBox. */
export interface CursorMaster {
  /** Uniform scale applied around the viewBox centre. */
  scale: number;
  /** The "o" ring. */
  circle: { cx: number; cy: number; r: number; strokeWidth: number };
  /** The cursor bar. */
  rect: { x: number; y: number; width: number; height: number; rx: number };
}

/** Width and height of the mark's viewBox. */
export const CURSOR_VIEWBOX = 24;

/** The small master, for every size up to and including 32 px (the in-app glyph too). */
export const CURSOR_SMALL: CursorMaster = {
  scale: 0.92,
  circle: { cx: 9, cy: 11, r: 5, strokeWidth: 2.8 },
  rect: { x: 16, y: 14.2, width: 5.5, height: 2.8, rx: 0.5 },
};

/** The large master, for sizes above 32 px. */
export const CURSOR_LARGE: CursorMaster = {
  scale: 0.8,
  circle: { cx: 9, cy: 11, r: 5, strokeWidth: 2.6 },
  rect: { x: 15, y: 14.9, width: 6.5, height: 2.1, rx: 0.6 },
};

/** Sizes up to this many pixels use the small master. */
export const SMALL_MASTER_MAX_SIZE = 32;

/** The master for a rendered size in pixels. */
export function cursorMasterFor(size: number): CursorMaster {
  return size <= SMALL_MASTER_MAX_SIZE ? CURSOR_SMALL : CURSOR_LARGE;
}

/** The transform that places a master's mark in the viewBox. */
export function cursorTransform(master: CursorMaster): string {
  return `translate(12 12) scale(${master.scale}) translate(-12 -11)`;
}
