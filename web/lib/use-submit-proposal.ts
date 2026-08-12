"use client";

/**
 * Proposing a case, with the same stage-by-stage honesty as every other write.
 *
 * Separate from `useSubmitAction` because a proposal has no case id going in
 * and produces one coming out: there is a fourth stage here, resolving which
 * case was created, and it is allowed to fail without that making the proposal
 * look failed. The money moved either way.
 */

import { useCallback, useState } from "react";

import {
  awaitExecution,
  describeWriteError,
  findProposedCaseId,
  submitProposal,
  type ProposalRequest,
} from "./contract";
import { useRefreshAfterWrite } from "./queries";
import type { SubmitStatus } from "./use-submit-action";
import { useWallet } from "@/components/wallet";

export function useSubmitProposal() {
  const { address } = useWallet();
  const refresh = useRefreshAfterWrite();
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [caseId, setCaseId] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setCaseId(null);
  }, []);

  const submit = useCallback(
    async (request: ProposalRequest) => {
      if (!address) {
        setStatus("failed");
        setError("Connect a wallet before proposing a case.");
        return;
      }
      setStatus("signing");
      setError(null);
      setCaseId(null);
      try {
        const submitted = await submitProposal(address, request);
        setStatus("waiting");

        const outcome = await awaitExecution(address, submitted.hash);
        if (!outcome.ok) {
          setStatus("failed");
          setError(outcome.reason);
          return;
        }

        setStatus("done");
        // The register changed, so the docket is stale regardless of whether
        // the new id can be pinned down.
        await refresh();
        try {
          setCaseId(await findProposedCaseId(address));
        } catch {
          // The case exists; only the link to it does not. Saying the proposal
          // failed here would be a lie about where the money went.
          setCaseId(null);
        }
      } catch (caught) {
        setStatus("failed");
        setError(describeWriteError(caught));
      }
    },
    [address, refresh],
  );

  return { submit, status, error, caseId, reset };
}
