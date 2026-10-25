/** An sRGB color with 0–255 channels. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses a `#rgb` or `#rrggbb` hex color. */
export function parseHex(value: string): Rgb {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim())?.[1];
  if (!hex) throw new Error(`Not a hex color: ${value}`);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio between two hex colors (1 to 21). */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(parseHex(foreground));
  const b = relativeLuminance(parseHex(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
