import type { Metadata } from "next";
import "@iamthemcmaster/ui/styles";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Omniralph",
  description: "Omniralph control panel: AI code review and agent fleet",
};

// Inline script — runs before paint to set the initial theme, avoiding
// a flash of wrong theme. Reads localStorage first, falls back to the
// OS preference.
const themeBootstrap = `
(function(){
  try {
    var stored = localStorage.getItem('mcmaster-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
