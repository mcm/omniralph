/** One rule's custom properties, keyed by name without the `--or-` prefix. */
export type TokenBlock = Record<string, string>;

/**
 * The `--or-` custom properties of each rule in a stylesheet, keyed by its selector list
 * normalized to `a, b`. Later declarations of a property in a rule win, as in CSS.
 */
export function parseTokenBlocks(css: string): Map<string, TokenBlock> {
  const blocks = new Map<string, TokenBlock>();
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!
      .trim()
      .split(",")
      .map((part) => part.trim())
      .join(", ");
    const block = blocks.get(selector) ?? {};
    for (const declaration of rule[2]!.matchAll(/--or-([\w-]+)\s*:\s*([^;]+);/g)) {
      block[declaration[1]!] = declaration[2]!.trim();
    }
    blocks.set(selector, block);
  }
  return blocks;
}

/** A color value normalized for comparison: lowercase, no spaces, no leading zeros on fractions. */
export function normalizeColor(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(^|[^\d.])0+(\.\d)/g, "$1$2");
}
