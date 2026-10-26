import type { Element, ElementContent, Root, RootContent } from "hast";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownProps {
  /** CommonMark plus GFM tables and task lists. Raw HTML is never rendered. */
  children: string;
  className?: string;
}

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Keeps absolute `http`, `https` and `mailto` URLs and drops everything else (relative
 * paths, fragments, `javascript:`, `data:`), so a document can't point into the app or run
 * script.
 */
export function safeMarkdownUrl(url: string): string | null {
  try {
    return SAFE_PROTOCOLS.has(new URL(url.trim()).protocol) ? url.trim() : null;
  } catch {
    return null;
  }
}

function textOf(node: ElementContent | RootContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

function isSectionHeading(node: RootContent): node is Element {
  return node.type === "element" && (node.tagName === "h1" || node.tagName === "h2");
}

function sectionName(node: RootContent): string | null {
  if (!isSectionHeading(node) || node.tagName !== "h2") return null;
  return textOf(node).trim().toLowerCase();
}

/**
 * Shapes the PRD sections: lists under `## Quality Gates` become ordered lists (Design
 * rule 19), and `## Open Questions` with everything up to the next `#`/`##` heading is
 * wrapped in a callout.
 */
function rehypePrdSections() {
  return (tree: Root) => {
    const children: RootContent[] = [];
    let section: string | null = null;
    let callout: Element | null = null;
    for (const node of tree.children) {
      if (isSectionHeading(node)) {
        section = sectionName(node);
        callout = null;
        if (section === "open questions") {
          callout = {
            type: "element",
            tagName: "section",
            properties: { className: ["or-md__callout"], dataCallout: "open-questions" },
            children: [],
          };
          children.push(callout);
        }
      }
      if (section === "quality gates" && node.type === "element" && node.tagName === "ul") {
        node.tagName = "ol";
        node.properties = { ...node.properties, className: ["or-md__gates"] };
      }
      if (callout && node.type !== "doctype") callout.children.push(node);
      else children.push(node);
    }
    tree.children = children;
  };
}

function MarkdownLink({
  node: _node,
  href,
  children,
  ...rest
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  if (!href) return <span className="or-md__dead-link">{children}</span>;
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function MarkdownTable({
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<"table"> & { node?: unknown }) {
  return (
    <div className="or-md__table">
      <table {...rest} />
    </div>
  );
}

const COMPONENTS: Components = { a: MarkdownLink, table: MarkdownTable };

/**
 * Renders a Markdown document (a PRD, a work item description, a chat answer) safely:
 * no raw HTML, only `http`, `https` and `mailto` links, each opening in a new tab.
 */
export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={["or-md", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypePrdSections]}
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
