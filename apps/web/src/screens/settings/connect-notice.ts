"use client";

import { toast } from "@omniralph/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  connectNotice,
  connectNoticeToast,
  OAUTH_PROVIDERS,
} from "@/lib/connections/connect-notices";

/**
 * The outcome a Linear, Slack or Discord connect flow landed with (`?linear=connected` on the
 * new connection's page, `?slack=denied` on Add connection, …): shows it as a toast (success
 * when connected, danger otherwise) once, and takes the parameter out of the URL so a reload
 * or a shared link doesn't show it again.
 */
export function useConnectNotice() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const shown = useRef<string | null>(null);
  const search = searchParams?.toString() ?? "";

  useEffect(() => {
    const params = new URLSearchParams(search);
    const landed = OAUTH_PROVIDERS.filter((provider) => params.has(provider));
    if (landed.length === 0) return;
    // Once per landing, even if the effect runs again before the URL changes.
    const landing = `${pathname}?${search}`;
    if (shown.current === landing) return;
    shown.current = landing;
    for (const provider of landed) {
      const notice = connectNotice(params.get(provider));
      if (notice) {
        const { message, variant } = connectNoticeToast(provider, notice);
        toast(message, { variant });
      }
      params.delete(provider);
    }
    const rest = params.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [pathname, router, search]);
}
