import type { Metadata } from "next";
import "@iamthemcmaster/ui/styles";
import "@iamthemcmaster/ui/styles/fonts";
import "@omniralph/ui/fonts.css";
import "@omniralph/ui/styles.css";
import "./globals.css";
import { getCurrentUser } from "@/lib/auth/session";
import { THEME_BOOTSTRAP } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Omniralph",
  description: "Omniralph control panel: AI code review and agent fleet",
  // Tile A, written by `pnpm --filter @omniralph/ui brand-assets`.
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The signed-in user's saved theme, rendered as a real attribute: React 19
  // strips attributes it doesn't own whenever it client-renders <html>, so a
  // theme set only by the bootstrap script can be lost.
  const theme = (await getCurrentUser())?.theme ?? undefined;
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
