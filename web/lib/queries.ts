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

/** Chain state here changes on human timescales; 30s is attentive enough. */
const REFRESH_MS = 30_000;

const BASE: SWRConfiguration = {
  refreshInterval: REFRESH_MS,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  shouldRetryOnError: true,
  errorRetryCount: 3,
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
    if (!describeReadError(error).retryable) return;
    if (retryCount >= (config.errorRetryCount ?? 3)) return;
    setTimeout(() => revalidate({ retryCount }), config.errorRetryInterval ?? 5_000);
  },
};

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
