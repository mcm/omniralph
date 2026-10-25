import Discord from "@thesvg/react/discord";
import Github from "@thesvg/react/github";
import Gitlab from "@thesvg/react/gitlab";
import Linear from "@thesvg/react/linear";
import Slack from "@thesvg/react/slack";

/** The brands @omniralph/ui draws marks for. */
export type Brand = "github" | "gitlab" | "linear" | "slack" | "discord";

/** Each brand's display name, used as the mark's accessible name. */
export const BRAND_NAMES: Record<Brand, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  linear: "Linear",
  slack: "Slack",
  discord: "Discord",
};

export interface BrandMarkProps {
  brand: Brand;
  /** Rendered width and height in pixels. Defaults to 14. */
  size?: number;
  className?: string;
}

const svgProps = (brand: Brand, size: number, className: string | undefined) => ({
  className: ["or-brand-mark", className].filter(Boolean).join(" "),
  width: size,
  height: size,
  role: "img",
  "aria-label": BRAND_NAMES[brand],
  focusable: "false" as const,
});

/**
 * A code-host, tracker or chat brand mark in one color (`currentColor`). Marks are
 * imported one by one by deep path, never from the `@thesvg/react` index.
 */
export function BrandMark({ brand, size = 14, className }: BrandMarkProps) {
  const props = svgProps(brand, size, className);
  switch (brand) {
    case "github":
      return <Github variant="mono" {...props} />;
    case "gitlab":
      return <Gitlab variant="mono" {...props} />;
    case "linear":
      return <Linear variant="mono" {...props} />;
    case "discord":
      return <Discord variant="mono" {...props} />;
    case "slack":
      // @thesvg/react has no mono Slack variant; refs.css paints its default mark in
      // currentColor (`.or-brand-mark--slack`).
      return <Slack {...props} className={`${props.className} or-brand-mark--slack`} />;
  }
}
