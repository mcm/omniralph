"use client";

import { UnsavedChangesBar, UnsavedChangesProvider } from "@/components/unsaved-changes";

/**
 * Every signed-in page inside the shell's `main`: the unsaved-changes guard, with its bar under
 * the page. The guard listens on the document, so it also asks before the shell's nav links
 * leave a page with unsaved changes.
 */
export function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <UnsavedChangesProvider>
      <div className="app-page">
        {children}
        <UnsavedChangesBar />
      </div>
    </UnsavedChangesProvider>
  );
}
