const INTERACTIVE = "a, button, input";

/**
 * Interactive elements (`a`, `button`, `input`) that sit inside an `a` or `button`:
 * invalid HTML that breaks keyboard and screen-reader use. Lists and tables keep their
 * row link and their checkboxes and actions as siblings, so this is empty for them.
 */
export function nestedInteractiveElements(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(INTERACTIVE)).filter(
    (element) => element.parentElement?.closest("a, button") != null,
  );
}
