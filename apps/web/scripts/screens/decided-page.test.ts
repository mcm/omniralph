// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  AGO,
  BANNED_HINTS,
  LIVE_INDICATORS,
  patternSources,
  REFRESH_CONTROL,
} from "../../src/lib/copy/banned-hints";
import { decidedInPage, expandedInPage } from "./decided-page.mjs";
import { decidedOptions } from "./checks";

function render(html: string) {
  document.body.innerHTML = html;
}

afterEach(() => {
  document.body.innerHTML = "";
});

const NAMES = ["fixture-labs/control-panel", "Fixture Labs", "build-01", "omniralph/fix-101"];

/** The options capture.mjs passes for a route (`decidedOptions`), with the fixture's names. */
function check(
  route: Parameters<typeof decidedOptions>[0] = {},
  org: "all" | "single" | null = null,
) {
  return decidedInPage(decidedOptions(route, { names: NAMES, org }));
}

/** A row as `ListRow` renders it. */
const row = (main: string) => `
  <ul class="or-rows"><li class="or-row">
    <a class="or-row__link" href="/runs/1"></a>
    <div class="or-row__main">
      <span class="or-row__kind" aria-hidden="true">Request · failed</span>
      <span class="or-row__title">Fix the login redirect</span>
      ${main}
    </div>
    <span class="or-row__time">4m</span>
  </li></ul>`;

const badge = (kind: string, text: string) =>
  `<span class="or-ref or-ref--${kind}" data-or-badge="${kind}"><span class="or-ref__text">${text}</span></span>`;

/** A detail header as the screens render it: badges, then the `Toolbar`. */
const header = ({ badges = "", toolbar = "", extra = "" }) => `
  <article><header class="or-run-detail__head">
    <div class="or-run-detail__badges">${badges}</div>
    <div role="toolbar" aria-label="Run actions" class="or-toolbar">${toolbar}</div>
    ${extra}
  </header><h2>Fix the login redirect</h2></article>`;

const ICON_BUTTON = `<button aria-label="Retry" data-state="closed" class="or-icon-btn"><svg aria-hidden="true"></svg></button>`;
const MORE = `<button aria-label="More actions" aria-haspopup="menu" data-state="closed" class="or-toolbar__more"><svg aria-hidden="true"></svg></button>`;

describe("bareMetadata", () => {
  it("passes metadata in badges, in sentences, in titles and in code", () => {
    render(`
      <main>
        <h2>FIX-101</h2>
        <div>${badge("issue", "FIX-101")} ${badge("repo", "fixture-labs/control-panel")}</div>
        <p>Om opened a pull request for <span>FIX-101</span> on the main branch.</p>
        <pre>FIX-101</pre>
        <button>Fixture Labs</button>
        <table><tr><th>Size</th><th>PRD</th></tr></table>
        <time>2h</time>
      </main>`);
    expect(check().bareMetadata).toEqual([]);
  });

  it("passes a row's title link and a sentence laid out as a flex row of spans", () => {
    render(`
      <main>
        <table><tr><td><a class="or-row-link" href="/fleet/1">build-01</a></td></tr></table>
        <p style="display: flex"><span>Fixture Labs</span><span>team</span><span>with no project</span></p>
      </main>`);
    expect(check().bareMetadata).toEqual([]);
  });

  it("finds a bare issue ID, version, fixture name, PRD and size word", () => {
    render(`
      <main>
        <div class="or-meta"><span>FIX-101</span> · <span>2h</span></div>
        <div>v2.4.1</div>
        <div><span>build-01</span></div>
        <div>PRD</div>
        <div>Medium</div>
        <div>Size M</div>
      </main>`);
    expect(check().bareMetadata).toEqual([
      '"FIX-101" in span',
      '"v2.4.1" in div',
      '"build-01" in span',
      '"PRD" in div',
      '"Medium" in div',
      '"Size M" in div',
    ]);
  });
});

describe("rowSummary", () => {
  it("passes a row with its kind line, title and badges", () => {
    render(
      row(`<div class="or-row__meta">${badge("issue", "FIX-101")} · ${badge("repo", "x/y")}</div>`),
    );
    expect(check().rowSummary).toEqual([]);
  });

  it("finds a stats line in a row", () => {
    render(row(`<span class="or-row__stats">3 of 5 stories done</span>`));
    expect(check().rowSummary).toEqual([
      '"Fix the login redirect": "3 of 5 stories done" in span.or-row__stats',
    ]);
  });

  it("finds a reason next to the badges", () => {
    render(
      row(
        `<div class="or-row__meta">${badge("issue", "FIX-101")} <span>Tests failed twice</span></div>`,
      ),
    );
    expect(check().rowSummary).toEqual([
      '"Fix the login redirect": "Tests failed twice" beside its badges',
    ]);
  });
});

describe("detailToolbar", () => {
  it("passes a header with named, tooltipped icon buttons and a More actions menu", () => {
    render(header({ toolbar: ICON_BUTTON + MORE }));
    expect(check({ detail: true }).detailToolbar).toEqual([]);
  });

  it("isn't checked outside detail routes", () => {
    render("<main><p>Runs</p></main>");
    expect(check().detailToolbar).toEqual([]);
  });

  it("finds a detail view without a toolbar", () => {
    render("<main><header><h2>Fix it</h2></header></main>");
    expect(check({ detail: true }).detailToolbar).toEqual([
      "no toolbar of detail actions in the page (rule 5)",
    ]);
  });

  it("lets the member's read-only view of a detail have no toolbar", () => {
    render("<main><header><h2>GitHub</h2></header></main>");
    expect(check({ detail: true, as: "member" }).detailToolbar).toEqual([]);
  });

  it("finds a header with text buttons", () => {
    render(
      header({
        toolbar: `<button data-state="closed">Retry run</button><button aria-label="Copy branch"><svg aria-hidden="true"></svg></button>${MORE}`,
        extra: `<button class="or-btn">Stop run</button>`,
      }),
    );
    expect(check({ detail: true }).detailToolbar).toEqual([
      '"Run actions": text-labeled button "Retry run" (rule 5)',
      '"Run actions": icon button "Copy branch" has no tooltip',
      'text-labeled button "Stop run" in the header header.or-run-detail__head (rule 6: only needs-you decisions)',
    ]);
  });

  it("allows a needs-you decision's labeled buttons in the header", () => {
    render(header({ toolbar: MORE, extra: `<button class="or-btn">Done, resume epic</button>` }));
    expect(check({ detail: true, needsYou: true }).detailToolbar).toEqual([]);
  });

  it("finds a More actions button that opens no menu, and a missing one on the panel", () => {
    render(header({ toolbar: ICON_BUTTON }));
    expect(check({ detail: true }).detailToolbar).toEqual([
      '"Run actions": no "More actions" (⋯) menu (rule 5)',
    ]);
    expect(check({ detail: true, surface: "agent" }).detailToolbar).toEqual([]);
    render(header({ toolbar: `<button aria-label="More actions" data-state="closed"></button>` }));
    expect(check({ detail: true }).detailToolbar).toEqual([
      '"Run actions": "More actions" doesn\'t open a menu',
    ]);
  });
});

describe("orgFirst", () => {
  const listRow = (badges: string) => row(`<div class="or-row__meta">${badges}</div>`);

  it("passes rows and headers that lead with the organization under All organizations", () => {
    render(
      listRow(badge("org", "Fixture Labs") + badge("issue", "FIX-101")) +
        header({ badges: badge("org", "Fixture Labs") + badge("meta", "Epic"), toolbar: MORE }),
    );
    expect(check({ detail: true, list: true }, "all").orgFirst).toEqual([]);
  });

  it("finds an organization badge second", () => {
    render(
      listRow(badge("issue", "FIX-101") + badge("org", "Fixture Labs")) +
        header({ badges: badge("meta", "Epic") + badge("org", "Fixture Labs"), toolbar: MORE }),
    );
    expect(check({ detail: true, list: true }, "all").orgFirst).toEqual([
      'row "Fix the login redirect": the first badge is issue "FIX-101", not the organization',
      'header header.or-run-detail__head: the first badge is meta "Epic", not the organization',
    ]);
  });

  it("accepts the organization badge in the phone's collapsed Details below the header", () => {
    render(`<article>
      <header>${badge("repo", "x/y")}<div role="toolbar" aria-label="Repo actions">${MORE}</div></header>
      <details><summary>Details</summary>${badge("org", "Fixture Labs")}</details>
    </article>`);
    expect(check({ detail: true }, "all").orgFirst).toEqual([]);
  });

  it("finds an organization badge with one organization selected", () => {
    render(listRow(badge("org", "Fixture Labs") + badge("issue", "FIX-101")));
    expect(check({ list: true }, "single").orgFirst).toEqual([
      'row "Fix the login redirect": shows the organization badge "Fixture Labs" with one organization selected',
    ]);
  });

  it("checks rows only on list and detail routes, and nothing without an organization scope", () => {
    render(listRow(badge("issue", "FIX-101")));
    expect(check({}, "all").orgFirst).toEqual([]);
    expect(check({ list: true }, null).orgFirst).toEqual([]);
  });
});

describe("hintText and liveIndicator", () => {
  it("finds hint text, in one block across inline elements", () => {
    render(
      `<main><p>Finished work is in <a href="/runs">Runs</a>.</p><p>Om reviews every pull request.</p></main>`,
    );
    expect(check().hintText).toEqual(['"Finished work is in Runs." in p']);
  });

  it("finds Live and Updated indicators, and … ago next to a refresh", () => {
    render(`
      <main>
        <div><span class="or-dot"></span><span>Live</span></div>
        <div class="bar"><p>3m ago</p><button aria-label="Refresh"></button></div>
        <ul><li>Request · failed</li><li><span>3m ago</span></li></ul>
        <div role="status">Live updates stopped. Retrying…</div>
        <p>Last updated: October 9, 2026</p>
      </main>`);
    expect(check().liveIndicator).toEqual(['"Live" in div', '"3m ago" in p']);
  });
});

describe("expandedInPage", () => {
  it("passes collapsed Details", () => {
    render(`<details><summary>Details</summary><p>Branch</p></details>
      <button aria-expanded="false">Session</button>
      <button aria-expanded="true" aria-haspopup="menu" aria-label="More actions"></button>`);
    expect(expandedInPage()).toEqual([]);
  });

  it("finds an expanded phone Details", () => {
    render(`<details open><summary>Details</summary><p>Branch</p></details>
      <button aria-expanded="true">Session</button>`);
    expect(expandedInPage()).toEqual([
      '"Details" is expanded on load',
      '"Session" is expanded on load',
    ]);
  });
});

describe("the banned copy lists", () => {
  it("are the ones decidedOptions passes to the page", () => {
    const options = decidedOptions({}, { names: [], org: null });
    expect(options.hints).toEqual(patternSources(BANNED_HINTS));
    expect(options.indicators).toEqual(patternSources(LIVE_INDICATORS));
    expect(options.ago).toEqual([AGO.source, AGO.flags]);
    expect(options.refresh).toEqual([REFRESH_CONTROL.source, REFRESH_CONTROL.flags]);
  });
});
