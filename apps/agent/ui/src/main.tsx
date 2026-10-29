/**
 * The agent page's entry: the providers around the app, mounted on `#root`. Fonts and
 * styles are bundled (no CDN, no inline styles), so the page works offline under its CSP.
 */
import "./zod-config.js";
import "@omniralph/ui/fonts.css";
import "@omniralph/ui/styles.css";
import "./styles.css";
import { ThemeProvider, Toaster, UiProvider } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { LiveProvider, type CreateEventSource } from "./live/live-provider.js";
import { createAgentQueryClient } from "./query-client.js";
import { Link, RouterProvider } from "./router.js";
import { readThemePreference, saveThemePreference } from "./theme.js";

export interface AgentPageRootProps {
  queryClient: QueryClient;
  /** For tests: a fake stream in place of `EventSource`. */
  createEventSource?: CreateEventSource;
}

export function AgentPageRoot({ queryClient, createEventSource }: AgentPageRootProps) {
  const [theme] = useState(readThemePreference);
  return (
    <RouterProvider>
      <UiProvider linkComponent={Link}>
        <ThemeProvider preference={theme} onPreferenceChange={saveThemePreference}>
          <QueryClientProvider client={queryClient}>
            <div className="or-root agent-root">
              <LiveProvider createEventSource={createEventSource}>
                <App />
              </LiveProvider>
              <Toaster />
            </div>
          </QueryClientProvider>
        </ThemeProvider>
      </UiProvider>
    </RouterProvider>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <AgentPageRoot queryClient={createAgentQueryClient()} />
    </StrictMode>,
  );
}
