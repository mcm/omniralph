import type { Metadata } from "next";
import "@iamthemcmaster/ui/styles";
import "./globals.css";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Omniralph",
  description: "Omniralph control panel: AI code review and agent fleet",
};

// Inline script — runs before paint when the server rendered no theme (signed
// out, or no choice saved yet), following the OS preference to avoid a flash
// of wrong theme.
const themeBootstrap = `
(function(){
  var root = document.documentElement;
  if (root.hasAttribute('data-theme')) return;
  try {
    root.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (_) {
    root.setAttribute('data-theme', 'light');
  }
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The signed-in user's saved theme, rendered as a real attribute: React 19
  // strips attributes it doesn't own whenever it client-renders <html>, so a
  // theme set only by the bootstrap script can be lost.
  const theme = (await getCurrentUser())?.theme ?? undefined;
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
