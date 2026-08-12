"use client";

/**
 * A localStorage-backed cache for SWR.
 *
 * Without it, every reload and every restored tab starts from an empty cache
 * and re-reads the whole docket - which on this contract is N+1 requests
 * against an endpoint that allows 30 per minute. With it, a returning user sees
 * the last known state instantly and the network read happens behind that,
 * spending budget only to correct what is already on screen.
 *
 * Two things this file has to get right:
 *
 *  - `bigint` does not survive JSON. Every amount, deadline and counter in this
 *    app is a bigint precisely because atto values overflow `number`, so the
 *    serialiser tags them and the parser restores them. Losing that would turn
 *    a cache into a precision bug, which is worse than no cache.
 *
 *  - A cache older than the data it describes is a liability. Entries carry the
 *    time they were written and anything past MAX_AGE_MS is dropped on load,
 *    so a tab opened tomorrow does not render yesterday's deadlines as current.
 */

import type { Cache, State } from "swr";

const STORAGE_KEY = "amicus-swr-cache";

/**
 * How long a persisted entry may still be shown before first read.
 *
 * Ten minutes: long enough to cover a reload, a restored session or a brief
 * disconnection, short enough that a countdown rendered from it is not
 * meaningfully wrong before the revalidation lands.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

const BIGINT_TAG = "__bigint__";

type Persisted = {
  readonly writtenAtMs: number;
  readonly entries: readonly (readonly [string, unknown])[];
};

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && BIGINT_TAG in (value as object)) {
    const raw = (value as Record<string, unknown>)[BIGINT_TAG];
    if (typeof raw === "string") return BigInt(raw);
  }
  return value;
}

function load(): Map<string, State<unknown>> {
  const empty = new Map<string, State<unknown>>();
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw, reviver) as Persisted;
    if (Date.now() - parsed.writtenAtMs > MAX_AGE_MS) return empty;
    return new Map(parsed.entries as [string, State<unknown>][]);
  } catch {
    // Corrupt or from an older shape. An empty cache is always safe; a
    // half-parsed one is not.
    return empty;
  }
}

function save(cache: Map<string, State<unknown>>): void {
  if (typeof window === "undefined") return;
  try {
    // Only settled data is worth keeping. Persisting an error would resurrect
    // a failure that may have already cleared, and persisting an in-flight
    // entry would restore a promise that no longer exists.
    const entries = [...cache.entries()]
      .filter(([, state]) => state?.data !== undefined && state?.error === undefined)
      .map(([key, state]) => [key, { data: state.data }] as const);
    // Never overwrite a populated cache with an empty one. A save can fire from
    // a provider that is no longer the one SWR is writing to, and losing a good
    // cache to a stray empty write is worse than skipping the write.
    if (entries.length === 0) return;
    const payload: Persisted = { writtenAtMs: Date.now(), entries };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload, replacer));
  } catch {
    // Quota exceeded, private mode, or storage disabled. The cache is an
    // optimisation; the app works without it.
  }
}

/**
 * The one cache for this page load.
 *
 * Deliberately module scope rather than per-component. React runs a component's
 * `useState` initialiser twice in development StrictMode, so building the cache
 * there produced two of them: SWR kept the second, while the first was left
 * orphaned with its listeners and interval still running - quietly writing its
 * own permanently empty map over the real one. The interval was never cleaned
 * up in production either.
 *
 * A module-level singleton means exactly one cache, one interval and one set of
 * listeners, however many times the provider component mounts.
 */
let singleton: Map<string, State<unknown>> | null = null;

/**
 * SWR cache provider that hydrates from and persists to localStorage.
 *
 * Writing on `beforeunload` alone loses everything on a crash or a killed tab,
 * so it also flushes periodically and when the tab is hidden - which is the
 * only one of the three that fires reliably on mobile.
 */
export function persistentCacheProvider(): Cache {
  if (singleton) return singleton as Cache;

  const map = load();
  singleton = map;

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => save(map));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") save(map);
    });
    window.setInterval(() => save(map), 30_000);
  }

  return map as Cache;
}
