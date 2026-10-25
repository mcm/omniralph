import { CURSOR_VIEWBOX, cursorMasterFor, cursorTransform } from "./geometry.js";

export interface GlyphProps {
  /** Rendered width and height in pixels. Picks the small master up to 32 px. */
  size?: number;
  /** Accessible name. Without one the glyph is decorative (`aria-hidden`). */
  label?: string;
  className?: string;
}

/**
 * The Cursor mark without a tile: the ring takes the text color (`currentColor`)
 * and the cursor the theme accent.
 */
export function Glyph({ size = 24, label, className }: GlyphProps) {
  const master = cursorMasterFor(size);
  const { circle, rect } = master;
  return (
    <svg
      className={className ? `or-glyph ${className}` : "or-glyph"}
      width={size}
      height={size}
      viewBox={`0 0 ${CURSOR_VIEWBOX} ${CURSOR_VIEWBOX}`}
      fill="none"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      focusable="false"
    >
      <g transform={cursorTransform(master)}>
        <circle
          cx={circle.cx}
          cy={circle.cy}
          r={circle.r}
          stroke="currentColor"
          strokeWidth={circle.strokeWidth}
        />
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={rect.rx}
          fill="var(--or-acc)"
        />
      </g>
    </svg>
  );
}
