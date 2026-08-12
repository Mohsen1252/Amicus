"use client";

/**
 * Submitting a case action, with the stages kept distinct.
 *
 * A declined signature, a transaction that reverted, and a node that could not
 * be reached are three different events and are reported as three different
 * things. The contract's own revert reason is surfaced whenever there is one.
 *
 * While a transaction is in flight its consensus state is polled, so `judge`
 * and `judge_appeal` - which make the contract fetch pages and run a model
 * panel, and can take a while - show what is actually happening rather than an
 * unchanging "Submitting...". The poll is best-effort: a failed poll is not a
 * failed transaction and never sets an error.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  awaitExecution,
  describeWriteError,
  fetchConsensus,
  submitAction,
  type ConsensusSnapshot,
  type WriteRequest,
} from "./contract";
import { useRefreshAfterWrite } from "./queries";
import { useWallet } from "@/components/wallet";

export type SubmitStatus = "idle" | "signing" | "waiting" | "done" | "failed";

/**
 * How often to ask the node where the transaction is.
 *
 * Fast enough that the phases are visible as they change, slow enough not to
 * hammer a node for the length of a model call.
 */
const POLL_MS = 2_500;

export function useSubmitAction(caseId: string) {
  const { address } = useWallet();
  const refresh = useRefreshAfterWrite();
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [consensus, setConsensus] = useState<ConsensusSnapshot | null>(null);

  // Guards a late poll against writing into state that has since been reset for
  // a different action.
  const liveHash = useRef<string | null>(null);

  useEffect(() => {
    if (!hash || status !== "waiting") return;
    let cancelled = false;

    const tick = async () => {
      const snapshot = await fetchConsensus(hash);
      if (cancelled || liveHash.current !== hash) return;
      if (snapshot) setConsensus(snapshot);
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hash, status]);

  const reset = useCallback(() => {
    liveHash.current = null;
    setStatus("idle");
    setError(null);
    setHash(null);
    setConsensus(null);
  }, []);

  const submit = useCallback(
    async (request: WriteRequest) => {
      if (!address) {
        setStatus("failed");
        setError("Connect a wallet before acting on a case.");
        return;
      }
      setStatus("signing");
      setError(null);
      setConsensus(null);
      try {
        const submitted = await submitAction(address, request);
        liveHash.current = submitted.hash;
        setHash(submitted.hash);
        setStatus("waiting");

        const outcome = await awaitExecution(address, submitted.hash);
        if (!outcome.ok) {
          setStatus("failed");
          setError(outcome.reason);
          // The case may still have moved on for other reasons, so refresh.
          await refresh(caseId);
          return;
        }
        setStatus("done");
        await refresh(caseId);
      } catch (caught) {
        setStatus("failed");
        setError(describeWriteError(caught));
      }
    },
    [address, caseId, refresh],
  );

  return { submit, status, error, hash, consensus, reset };
}
