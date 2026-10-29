/**
 * The cover under a modal (sheet, confirm dialog, menu drawer, search palette), rendered
 * inside its Radix portal in place of Radix's `Overlay`. The Overlay's scroll lock
 * (react-remove-scroll) injects a `<style>` element, which a page whose Content Security
 * Policy refuses inline styles blocks (the agent's local page). The page under a modal stops
 * scrolling through CSS instead (`:root:has(.or-scrim)` in surfaces.css), and a click on the
 * scrim is outside the dialog, so Radix still closes it where the dialog allows that.
 */
export function Scrim({ className }: { className: string }) {
  // The caller's class first: impeccable detect names an element by its first class. The
  // modal leaves the body without pointer events; the scrim takes them back (as Radix's
  // Overlay does) so a click on it closes the modal. A style property set from script is
  // CSSOM, which the CSP allows.
  return (
    <div className={`${className} or-scrim`} aria-hidden="true" style={{ pointerEvents: "auto" }} />
  );
}
