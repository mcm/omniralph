import { parseArgs } from "node:util";

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

/**
 * The three layouts (DESIGN.md, "Widths and accessibility"): the full sidebar (1200px and
 * wider), the 64px icon rail (769–1199px) and the phone's top bar and tab bar (768px and
 * narrower).
 */
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  rail: { width: 1024, height: 768 },
  phone: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
export const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];

/**
 * What is captured: the control panel (`routes.ts`, against the fixture database) and the
 * agent's local page (`apps/agent/scripts/ui-fixture`, its fixture mode).
 */
export const SURFACES = ["panel", "agent"] as const;
export type Surface = (typeof SURFACES)[number];

/** The values of `--surface` and its alias `--app` beyond the surfaces' own names. */
const SURFACE_ALIASES: Record<string, readonly Surface[]> = {
  web: ["panel"],
  all: SURFACES,
};

export interface ScreensOptions {
  /** `--routes`: comma-separated globs over route names and paths. */
  routes: string | null;
  themes: Theme[];
  viewports: ViewportName[];
  surfaces: Surface[];
  /**
   * `--strict`: exit non-zero when a route scrolls horizontally, or has an accessibility
   * finding that ignore.md doesn't ignore.
   */
  strict: boolean;
  /** `--skip-build`: don't build the workspace packages first. */
  skipBuild: boolean;
  help: boolean;
}

export const USAGE = `Usage: pnpm --filter @omniralph/web verify:screens [options]

Screenshots every panel route (scripts/screens/routes.ts) against the fixture
database, and every screen of the agent's local page in its fixture mode
(apps/agent/scripts/ui-fixture), at 1440px (sidebar), 1024px (icon rail) and
390px (phone), in the dark and light themes, and checks each capture's
accessibility: axe-core (WCAG 2.2 A and AA), a keyboard walk, Escape on the
overlays a route opens, and its landmarks.

Options:
  --routes <glob>     Only routes whose name or path matches (comma-separated;
                      * within a path segment, ** across), e.g. "settings-*"
                      or "/runs/**"
  --theme <themes>    dark, light or both (comma-separated; default both)
  --viewport <names>  desktop (1440px), rail (1024px) or phone (390px)
                      (comma-separated; 1440, 1024 and 390 also work; default all)
  --surface <names>   panel, agent or both (comma-separated; default both)
  --app <names>       Same as --surface: web (the panel), agent or all
  --strict            Exit non-zero when a route is wider than its viewport, or
                      has an accessibility finding (axe, keyboard, Escape,
                      landmarks) that no entry of .impeccable/critique/ignore.md
                      ignores
  --skip-build        Don't build the workspace packages the panel imports, or
                      the agent page
  --help              Show this help
`;

export function parseScreensOptions(argv: string[]): ScreensOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      routes: { type: "string" },
      theme: { type: "string" },
      viewport: { type: "string" },
      surface: { type: "string" },
      app: { type: "string" },
      strict: { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    routes: values.routes ?? null,
    themes: parseList(values.theme, "--theme", (item) =>
      (THEMES as readonly string[]).includes(item) ? (item as Theme) : null,
    ) ?? [...THEMES],
    viewports: parseList(values.viewport, "--viewport", parseViewport) ?? [...VIEWPORT_NAMES],
    surfaces: parseSurfaces(values.surface, values.app) ?? [...SURFACES],
    strict: values.strict,
    skipBuild: values["skip-build"],
    help: values.help,
  };
}

/** `--surface` or `--app` (not both): surface names, `web` for the panel, `all` for both. */
function parseSurfaces(surface: string | undefined, app: string | undefined): Surface[] | null {
  if (surface !== undefined && app !== undefined) {
    throw new Error("--app is another name for --surface: give one of them");
  }
  const flag = app !== undefined ? "--app" : "--surface";
  const lists = parseList(app ?? surface, flag, (item) =>
    (SURFACES as readonly string[]).includes(item)
      ? [item as Surface]
      : (SURFACE_ALIASES[item] ?? null),
  );
  return lists && SURFACES.filter((name) => lists.some((list) => list.includes(name)));
}

function parseViewport(item: string): ViewportName | null {
  if ((VIEWPORT_NAMES as string[]).includes(item)) return item as ViewportName;
  for (const [name, { width }] of Object.entries(VIEWPORTS)) {
    if (item === String(width) || item === `${width}px`) return name as ViewportName;
  }
  return null;
}

function parseList<T>(
  value: string | undefined,
  flag: string,
  parse: (item: string) => T | null,
): T[] | null {
  if (value === undefined) return null;
  const items = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) throw new Error(`${flag} needs a value`);
  const parsed: T[] = [];
  for (const item of items) {
    const result = parse(item);
    if (result === null) throw new Error(`${flag}: unknown value "${item}"`);
    if (!parsed.includes(result)) parsed.push(result);
  }
  return parsed;
}
