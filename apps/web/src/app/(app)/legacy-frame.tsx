"use client";

import { SidebarProvider, TooltipProvider } from "@iamthemcmaster/ui";
import { AppSidebar } from "@/components/app-sidebar";
import { UnsavedChangesBar, UnsavedChangesProvider } from "@/components/unsaved-changes";

/**
 * Today's Precision Aurora frame inside `AppShell`: the library's sidebar, its tooltips
 * (today's pages use them) and the panel's unsaved-changes guard. It lives with today's
 * screens so the shell itself doesn't depend on `@iamthemcmaster/ui`; the rebuilt shell
 * (TOOL-614) replaces it.
 */
export function LegacyFrame({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      {/* No AuroraField: this frame wraps the data surfaces, which sit on a flat page
        (DESIGN.md). Below 768px the sidebar is the library's navigation sheet, opened
        from the trigger in AppHeader. */}
      <UnsavedChangesProvider>
        <SidebarProvider>
          <div className="app-shell flex">
            <AppSidebar />
            <div className="flex flex-1 flex-col min-w-0">
              {children}
              <UnsavedChangesBar />
            </div>
          </div>
        </SidebarProvider>
      </UnsavedChangesProvider>
    </TooltipProvider>
  );
}
