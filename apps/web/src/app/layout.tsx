import type { Metadata } from "next";
import "@iamthemcmaster/ui/styles";
import "@iamthemcmaster/ui/styles/fonts";
import "./globals.css";
import { getCurrentUser } from "@/lib/auth/session";
import { THEME_BOOTSTRAP } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Omniralph",
  description: "Omniralph control panel: AI code review and agent fleet",
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
