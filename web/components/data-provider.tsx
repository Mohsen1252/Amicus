"use client";

/**
 * Installs the persistent SWR cache for the whole app.
 *
 * Separate from the layout because the cache provider must be constructed once
 * on the client and never on the server: it reads localStorage, which does not
 * exist during SSR.
 */

import { SWRConfig } from "swr";
import { useState } from "react";

import { persistentCacheProvider } from "@/lib/swr-cache";

export function DataProvider({ children }: { children: React.ReactNode }) {
  // Built once, in state rather than a module constant, so the listeners it
  // registers are tied to this mount instead of to module evaluation.
  const [provider] = useState(() => {
    const cache = persistentCacheProvider();
    return () => cache;
  });

  return <SWRConfig value={{ provider }}>{children}</SWRConfig>;
}
