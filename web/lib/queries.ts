"use client";

/**
 * The app's one data-fetching approach.
 *
 * SWR, with the contract client as the fetcher. It is the only cache: there is
 * no store, no duplicated chain state in component state, and no second path
 * that could disagree with this one. That is the justification for the
 * dependency - the alternative was hand-rolling deduplication, revalidation and
 * per-view error state, which is the same thing with more bugs.
 *
 * Revalidation is deliberate rather than aggressive:
 *  - a slow interval, because chain state changes at human speed here
 *  - on focus, so a tab left open overnight is not trusted
 *  - explicitly after a write, via `mutate`, rather than by polling faster
 *
 * A case detail is one cache entry holding the whole bundle, so updating one
 * row never refetches the case and vice versa.
 */

import useSWR, { useSWRConfig, type SWRConfiguration } from "swr";

import {
  describeReadError,
  fetchCaseBundle,
  fetchCasePage,
  fetchStats,
  type CaseBundle,
} from "./contract";
import type { CaseRecord, ContractStats } from "./types";

/**
 * How often to re-read, and why it is this slow.
 *
 * The docket is not one request. `fetchCasePage` asks `list_cases` and then one
 * `get_case` per row, because the contract exposes no batched view - so a page
 * of N cases costs N+1 requests, plus one for the stats.
 *
 * StudioNet allows 30 requests per minute and 500 per hour. At the previous 30s
 * interval that arithmetic does not work:
 *
 *   5 cases,  30s -> 7 req/cycle -> 14 req/min ->  840 req/hour   over budget
 *   5 cases, 120s -> 7 req/cycle -> 3.5 req/min -> 210 req/hour   fits
 *
 * The app was exceeding the hourly ceiling while sitting idle with nobody
 * touching it, which is why the banner appeared "frequently" and seemingly at
 * random. No amount of caching fixes that; the polling rate itself has to fit
 * inside the budget.
 */
const REFRESH_MS = 120_000;

/**
 * Repeat reads of the same key within this window are served from cache.
 *
 * Mounting the docket and a case view together, or navigating back and forth,
 * would otherwise re-ask the same questions seconds apart.
 */
const DEDUPE_MS = 60_000;

const BASE: SWRConfiguration = {
  refreshInterval: REFRESH_MS,
  dedupingInterval: DEDUPE_MS,
  /**
   * Off deliberately. Every tab switch back to the app was a full docket
   * re-read - N+1 requests for information that changes on human timescales.
   * The interval above already keeps the view fresh, and a write refreshes
   * explicitly through `useRefreshAfterWrite`.
   */
  revalidateOnFocus: false,
  /** A reconnect is worth one read: the app may have been offline for hours. */
  revalidateOnReconnect: true,
  shouldRetryOnError: true,
  errorRetryCount: 5,
  keepPreviousData: true,

  /**
   * Do not burst-retry a refusal that is going to refuse identically.
   *
   * The contract's [EXPECTED] errors - an unknown case id, a malformed
   * argument - are deterministic. SWR's default is three retries in quick
   * succession, which asks a node to re-derive the same "no" three times and
   * puts three more failures in the console for a question already answered.
   *
   * The slow interval revalidation is deliberately left in place. An id that
   * does not resolve now is not guaranteed never to resolve: case ids are
   * sequential, so `case-999` becomes real once 999 cases exist. "Will not
   * change in the next few seconds" is a different claim from "will never
   * change", and only the first one is safe to act on here.
   */
  onErrorRetry: (error, _key, config, revalidate, { retryCount }) => {
    const failure = describeReadError(error);
    if (!failure.retryable) return;
    if (retryCount >= (config.errorRetryCount ?? 5)) return;
    setTimeout(() => revalidate({ retryCount }), backoffMs(retryCount, failure.rateLimited));
  },
};

/**
 * How long to wait before retry number `retryCount`.
 *
 * Exponential, and deliberately slower when the node said "rate limit". Backing
 * off gently from a throttle is worse than not retrying at all: each early
 * attempt is itself a request, so it spends the budget that the wait was
 * supposed to let recover. The first rate-limited retry therefore waits long
 * enough for a per-minute window to roll over rather than a few seconds.
 *
 * Jitter matters here because the docket fires N+1 requests at once. Without
 * it, every one of them would fail together and then retry together,
 * reproducing the same burst that caused the throttle.
 */
function backoffMs(retryCount: number, rateLimited: boolean): number {
  const base = rateLimited ? 20_000 : 3_000;
  const ceiling = rateLimited ? 180_000 : 30_000;
  const grown = Math.min(base * 2 ** retryCount, ceiling);
  return grown * (0.75 + Math.random() * 0.5);
}

export const cacheKeys = {
  stats: () => ["stats"] as const,
  casePage: (offset: number, limit: number) => ["cases", offset, limit] as const,
  caseBundle: (caseId: string) => ["case", caseId] as const,
};

export function useStats() {
  return useSWR<ContractStats>(cacheKeys.stats(), fetchStats, BASE);
}

export function useCasePage(offset: number, limit: number) {
  return useSWR<readonly CaseRecord[]>(
    cacheKeys.casePage(offset, limit),
    () => fetchCasePage(offset, limit),
    BASE,
  );
}

export function useCaseBundle(caseId: string) {
  return useSWR<CaseBundle>(
    cacheKeys.caseBundle(caseId),
    () => fetchCaseBundle(caseId),
    BASE,
  );
}

/**
 * Refresh what a successful write changed, and only that.
 *
 * A case action changes the case and the counters; it does not change any other
 * case, so nothing else is invalidated.
 */
export function useRefreshAfterWrite() {
  const { mutate } = useSWRConfig();
  return async (caseId?: string) => {
    const pending: Promise<unknown>[] = [mutate(cacheKeys.stats())];
    if (caseId) pending.push(mutate(cacheKeys.caseBundle(caseId)));
    // Case rows carry state and deadlines, so any open list page is now stale.
    pending.push(
      mutate((key) => Array.isArray(key) && key[0] === "cases", undefined, {
        revalidate: true,
      }),
    );
    await Promise.all(pending);
  };
}
