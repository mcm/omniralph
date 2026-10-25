"use client";

import { TooltipProvider } from "@iamthemcmaster/ui";
import { UnsavedChangesBar, UnsavedChangesProvider } from "@/components/unsaved-changes";

/**
 * What today's Precision Aurora pages need inside the 2.0 shell's `main`: the library's
 * tooltips and the panel's unsaved-changes guard, with its bar under the page. It lives with
 * today's screens so `AppShell` itself doesn't depend on `@iamthemcmaster/ui`; it goes once
 * Epics 5–10 have replaced every page that uses them. The guard listens on the document, so
 * it also asks before the shell's nav links leave a page with unsaved changes.
 */
export function LegacyFrame({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <UnsavedChangesProvider>
        <div className="legacy-page">
          {children}
          <UnsavedChangesBar />
        </div>
      </UnsavedChangesProvider>
    </TooltipProvider>
  );
}
