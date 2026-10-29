// The Decided checks capture.mjs runs on each capture (apps/web/DESIGN.md, "Decided — never
// flag, never undo"; see ../../README.md). Plain JS, copied into the Playwright container next
// to capture.mjs. The `*InPage` functions run in the page (`page.evaluate`), so each is
// self-contained: it uses nothing from this module's scope and takes one options argument.
// decided-page.test.ts runs them in jsdom against small HTML fixtures.

/**
 * The checks of one capture, each a list of findings (empty when it passes):
 * - `hintText`: text about where things are (rule 3), from `options.hints`.
 * - `liveIndicator`: a "Live" or "Updated" indicator (rules 9 and 22), from
 *   `options.indicators`, or "… ago" next to a refresh control; `options.indicatorAllowed`
 *   (exact texts or `[source, flags]` patterns) are allowed.
 * - `bareMetadata`: metadata shown on its own, not as a badge (rules 1 and 2): a text node that
 *   is exactly an issue ID, a version, a branch Omniralph names, one of `options.names` (repos,
 *   branches, organizations, agents), "PRD", a size word or "Size …", outside `[data-or-badge]` and not in a sentence.
 *   Titles, controls, timestamps, code and rendered Markdown are exempt.
 * - `rowSummary`: a list row (`ListRow`) with more than its kind and state line, its title and
 *   its badges (rule 8).
 * - `detailToolbar` (`options.detail`): the detail header holds (unless `options.requireToolbar`
 *   is false: a read-only view may have no actions) a toolbar of icon buttons, each
 *   named and tooltipped, and (`options.requireMenu`) a "More actions" button that opens a menu;
 *   no text-labeled button in the header unless `options.needsYou` (rules 5 and 6).
 * - `orgFirst` (`options.org`): with `"all"`, the first badge of each list row
 *   (`options.rows`) and detail header (`options.detail`) is the organization's; with
 *   `"single"`, neither shows an organization badge (rule 13).
 * @param {{
 *   hints: [string, string][],
 *   indicators: [string, string][],
 *   indicatorAllowed: (string | [string, string])[],
 *   ago: [string, string],
 *   refresh: [string, string],
 *   names: string[],
 *   detail?: boolean,
 *   needsYou?: boolean,
 *   requireToolbar?: boolean,
 *   requireMenu?: boolean,
 *   rows?: boolean,
 *   org?: "all" | "single" | null,
 * }} options
 */
export function decidedInPage(options) {
  const regex = ([source, flags]) => new RegExp(source, flags);
  const hints = options.hints.map(regex);
  const indicators = options.indicators.map(regex);
  const allowed = options.indicatorAllowed.map((entry) =>
    typeof entry === "string" ? (text) => text === entry : (text) => regex(entry).test(text),
  );
  const ago = regex(options.ago);
  const refresh = regex(options.refresh);
  const names = new Set(options.names);
  const METADATA = [
    /^[A-Z][A-Z0-9]+-\d+$/, // an issue ID
    /^v?\d+\.\d+(\.\d+)?$/, // a version
    /^omniralph\/[a-z][a-z0-9]*-\d+(-[a-z0-9-]+)?$/, // a branch Omniralph names
    /^(PRD|Small|Medium|Large)$/,
    /^Size \S/,
  ];
  // Content, not UI copy: code, transcripts, diffs, rendered Markdown and form values.
  const CONTENT =
    "pre, code, kbd, samp, textarea, input, select, [contenteditable], .or-md, .or-transcript, .or-diff, script, style, noscript, template";
  // Text that names a control or titles a page isn't standalone metadata.
  const NAMING =
    'h1, h2, h3, h4, h5, h6, [role="heading"], .or-row__title, .or-row-link, button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], label, legend, th, [role="columnheader"], caption, dt, time, [role="tooltip"]';

  const visible = (element) => {
    if (element.closest("[inert]")) return false;
    if (typeof element.checkVisibility === "function") {
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
        return false;
      }
      // jsdom has no layout: every box is empty there, so only a real browser checks sizes.
      if (navigator.userAgent.includes("jsdom")) return true;
      const box = element.getBoundingClientRect();
      return box.width * box.height > 1;
    }
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden) return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const describe = (element) => {
    let text = element.tagName.toLowerCase();
    const classes = [...element.classList].slice(0, 2);
    if (classes.length > 0) text += `.${classes.join(".")}`;
    return text;
  };
  const clean = (text) => text.replace(/\s+/g, " ").trim();
  const quote = (text) => JSON.stringify(text.length > 80 ? `${text.slice(0, 79)}…` : text);
  const isBlock = (element) => {
    const display = getComputedStyle(element).display;
    return display !== "contents" && !display.startsWith("inline");
  };
  const blockOf = (node) => {
    let element = node.parentElement;
    while (element && element !== document.body && !isBlock(element)) {
      element = element.parentElement;
    }
    return element ?? document.body;
  };
  /** The block's own text: its text nodes, without those of blocks nested in it. */
  const ownText = (block) => {
    let text = "";
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
        else if (child.nodeType === Node.ELEMENT_NODE && !isBlock(child)) walk(child);
        else if (child.nodeType === Node.ELEMENT_NODE) text += " ";
      }
    };
    walk(block);
    return clean(text);
  };
  const textNodes = () => {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || clean(node.textContent) === "") continue;
      if (parent.closest("script, style, noscript, template")) continue;
      if (!visible(parent)) continue;
      nodes.push(node);
    }
    return nodes;
  };
  const nodes = textNodes();
  const blocks = [...new Set(nodes.map(blockOf))]
    .filter((block) => !block.closest(CONTENT))
    .map((block) => ({ block, text: ownText(block) }))
    .filter(({ text }) => text !== "");

  const hintText = blocks
    .filter(({ text }) => hints.some((pattern) => pattern.test(text)))
    .map(({ block, text }) => `${quote(text)} in ${describe(block)}`);

  const namesRefresh = (control) =>
    refresh.test(control.getAttribute("aria-label") ?? "") ||
    refresh.test(control.getAttribute("title") ?? "") ||
    refresh.test(clean(control.textContent ?? ""));
  const nextToRefresh = (block) => {
    const around = block.parentElement ?? block;
    return [...around.querySelectorAll('button, a[href], [role="button"]')].some(
      (control) => visible(control) && namesRefresh(control),
    );
  };
  const liveIndicator = blocks
    .filter(({ text }) => !allowed.some((allow) => allow(text)))
    .filter(
      ({ block, text }) =>
        indicators.some((pattern) => pattern.test(text)) ||
        (ago.test(text) && nextToRefresh(block)),
    )
    .map(({ block, text }) => `${quote(text)} in ${describe(block)}`);

  // A sentence: two words in a row besides the metadata itself.
  const SENTENCE = /[A-Za-z]{2,}[,;:]?\s+[A-Za-z]{2,}/;
  const bareMetadata = nodes
    .filter((node) => {
      const text = clean(node.textContent);
      if (!names.has(text) && !METADATA.some((pattern) => pattern.test(text))) return false;
      const parent = node.parentElement;
      if (parent.closest("[data-or-badge]") || parent.closest(CONTENT) || parent.closest(NAMING)) {
        return false;
      }
      // A flex or grid item (every child of one is a block) reads with its siblings: a sentence
      // laid out as a row of spans is still a sentence.
      const block = blockOf(node);
      const container = block.parentElement;
      const display = container ? getComputedStyle(container).display : "";
      const around = (
        /flex|grid/.test(display) ? clean(container.textContent ?? "") : ownText(block)
      ).replace(text, " ");
      return !SENTENCE.test(around);
    })
    .map((node) => `${quote(clean(node.textContent))} in ${describe(node.parentElement)}`);

  const rowSummary = [];
  for (const row of document.querySelectorAll(".or-row")) {
    if (!visible(row)) continue;
    const main = row.querySelector(".or-row__main");
    if (!main) continue;
    const title = clean(row.querySelector(".or-row__title")?.textContent ?? "");
    for (const child of main.children) {
      if (!visible(child) || clean(child.textContent ?? "") === "") continue;
      if (child.matches(".or-row__kind, .or-row__title")) continue;
      if (child.matches(".or-row__meta")) {
        const loose = [];
        const walk = (node) => {
          for (const part of node.childNodes) {
            if (part.nodeType === Node.TEXT_NODE) {
              if (clean(part.textContent) !== "" && !/^[·•|,]$/.test(clean(part.textContent))) {
                loose.push(clean(part.textContent));
              }
            } else if (
              part.nodeType === Node.ELEMENT_NODE &&
              visible(part) &&
              !part.matches("[data-or-badge], [role='img'], .or-dot, time")
            ) {
              walk(part);
            }
          }
        };
        walk(child);
        if (loose.length > 0) {
          rowSummary.push(`${quote(title)}: ${quote(loose.join(" "))} beside its badges`);
        }
        continue;
      }
      rowSummary.push(`${quote(title)}: ${quote(clean(child.textContent))} in ${describe(child)}`);
    }
  }

  const scope = document.querySelector("main") ?? document.body;
  const toolbars = [...scope.querySelectorAll('[role="toolbar"]')].filter(visible);
  const headers = [
    ...new Set(toolbars.map((toolbar) => toolbar.closest("header") ?? toolbar.parentElement)),
  ];
  const textOf = (control) => {
    const copy = control.cloneNode(true);
    copy
      .querySelectorAll('[aria-hidden="true"], svg, .or-sr-only')
      .forEach((part) => part.remove());
    return clean(copy.textContent ?? "");
  };
  const detailToolbar = [];
  if (options.detail) {
    if (toolbars.length === 0 && options.requireToolbar !== false) {
      detailToolbar.push("no toolbar of detail actions in the page (rule 5)");
    }
    for (const toolbar of toolbars) {
      const name = toolbar.getAttribute("aria-label") ?? describe(toolbar);
      const controls = [...toolbar.querySelectorAll('button, a[href], [role="button"]')].filter(
        visible,
      );
      for (const control of controls) {
        const label = control.getAttribute("aria-label") ?? "";
        const text = textOf(control);
        if (text !== "") {
          detailToolbar.push(`${quote(name)}: text-labeled button ${quote(text)} (rule 5)`);
        } else if (label.trim() === "" && !control.hasAttribute("aria-labelledby")) {
          detailToolbar.push(`${quote(name)}: an icon button without a name`);
        } else if (!control.hasAttribute("data-state")) {
          detailToolbar.push(`${quote(name)}: icon button ${quote(label)} has no tooltip`);
        }
      }
      const more = controls.find(
        (control) => control.getAttribute("aria-label") === "More actions",
      );
      if (more && more.getAttribute("aria-haspopup") !== "menu") {
        detailToolbar.push(`${quote(name)}: "More actions" doesn't open a menu`);
      }
      if (!more && options.requireMenu) {
        detailToolbar.push(`${quote(name)}: no "More actions" (⋯) menu (rule 5)`);
      }
    }
    if (!options.needsYou) {
      for (const header of headers) {
        for (const control of header.querySelectorAll('button, [role="button"], a.or-btn')) {
          if (control.closest('[role="toolbar"]') || !visible(control)) continue;
          const text = textOf(control);
          if (text === "") continue;
          detailToolbar.push(
            `text-labeled button ${quote(text)} in the header ${describe(header)} (rule 6: only needs-you decisions)`,
          );
        }
      }
    }
  }

  const orgFirst = [];
  if (options.org) {
    const badgesOf = (element) => [...element.querySelectorAll("[data-or-badge]")].filter(visible);
    const checkFirst = (element, what) => {
      const badges = badgesOf(element);
      if (badges.length === 0) return;
      const org = badges.filter((badge) => badge.getAttribute("data-or-badge") === "org");
      // The phone's light layout (rule 16) may move it into the detail's collapsed Details.
      const collapsedOrg = what.startsWith("header")
        ? element.parentElement?.querySelector('details:not([open]) [data-or-badge="org"]')
        : null;
      if (
        options.org === "all" &&
        badges[0].getAttribute("data-or-badge") !== "org" &&
        !collapsedOrg
      ) {
        orgFirst.push(
          `${what}: the first badge is ${badges[0].getAttribute("data-or-badge")} ${quote(clean(badges[0].textContent ?? ""))}, not the organization`,
        );
      } else if (options.org === "single" && org.length > 0) {
        orgFirst.push(
          `${what}: shows the organization badge ${quote(clean(org[0].textContent ?? ""))} with one organization selected`,
        );
      }
    };
    if (options.rows) {
      for (const row of scope.querySelectorAll(
        ".or-row, .or-repo-row, .or-tbl__row, .or-cardrow",
      )) {
        if (!visible(row)) continue;
        const title = clean(
          row.querySelector(".or-row__title")?.textContent ?? row.textContent ?? "",
        ).slice(0, 40);
        checkFirst(row, `row ${quote(title)}`);
      }
    }
    if (options.detail) {
      for (const header of headers) checkFirst(header, `header ${describe(header)}`);
    }
  }

  return { hintText, liveIndicator, bareMetadata, rowSummary, detailToolbar, orgFirst };
}

/**
 * The phone's detail views load light (rule 16, Decided `light-phone-layout`): every Details
 * disclosure is collapsed. The open ones (`details[open]`, or an `aria-expanded="true"` that
 * isn't a menu's or a popup's), as findings. Run on load, before a route's steps.
 */
export function expandedInPage() {
  const visible = (element) =>
    typeof element.checkVisibility === "function"
      ? element.checkVisibility({ visibilityProperty: true })
      : getComputedStyle(element).display !== "none";
  const name = (element) =>
    (element.matches("details")
      ? (element.querySelector("summary")?.textContent ?? "")
      : (element.getAttribute("aria-label") ?? element.textContent ?? "")
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  return [
    ...document.querySelectorAll('details[open], [aria-expanded="true"]:not([aria-haspopup])'),
  ]
    .filter(visible)
    .map((element) => `${JSON.stringify(name(element))} is expanded on load`);
}
