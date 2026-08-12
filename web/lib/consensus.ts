/**
 * GenLayer's consensus phases, in the terms this contract makes them mean.
 *
 * A GenLayer transaction is not a single atomic step. A leader executes it, a
 * validator panel independently re-derives the result, votes are committed and
 * then revealed, and only then is the transaction accepted. For most of Amicus
 * that distinction is invisible - `release` is over in one round. For `judge`
 * and `judge_appeal` it is the whole story: the leader is fetching every cited
 * page and running a model over them, and each validator is doing the same work
 * again under a *different framing* before agreeing.
 *
 * That takes real time, and a spinner labelled "Submitting..." for a minute is
 * indistinguishable from a hung app. So this maps the node's own
 * TransactionStatus onto plain sentences.
 *
 * Every phase below is reported, never predicted. There is deliberately no
 * percentage and no time estimate: the contract can rotate leaders, and a
 * progress bar that goes backwards is worse than no progress bar. Nothing here
 * is shown unless the node said it.
 */

import type { ConsensusSnapshot } from "./contract";

/** Where a transaction is, reduced to the phases a person needs distinguished. */
export type ConsensusPhase =
  | "queued"
  | "executing"
  | "validating"
  | "revealing"
  | "settled"
  | "stalled";

export type ConsensusStage = {
  readonly phase: ConsensusPhase;
  readonly label: string;
  /** What is actually happening, in this contract's terms. */
  readonly detail: string;
  /** True once the transaction has stopped moving, either way. */
  readonly terminal: boolean;
};

/**
 * Whether this action makes the contract do non-deterministic work.
 *
 * Only these two reach `gl.vm.run_nondet_unsafe`. The rest are ordinary state
 * transitions and do not warrant a panel readout.
 */
export function isNonDeterministic(action: string): boolean {
  return action === "judge" || action === "judge_appeal";
}

/**
 * The sentence for each status.
 *
 * `nondet` decides only how the leader phase is described: during PROPOSING the
 * leader is running the contract, and for a judgment that specifically means
 * fetching evidence URLs and putting them to a model.
 */
export function describeConsensus(
  snapshot: ConsensusSnapshot,
  nondet: boolean,
): ConsensusStage {
  switch (snapshot.status) {
    case "UNINITIALIZED":
    case "PENDING":
      return {
        phase: "queued",
        label: "Queued",
        detail: "The transaction is waiting to be picked up for execution.",
        terminal: false,
      };

    case "PROPOSING":
      return {
        phase: "executing",
        label: "Leader executing",
        detail: nondet
          ? "The leader is fetching every cited page and putting the record to a model. " +
            "This is the slow step: the pages are being retrieved now, not read from storage."
          : "The leader is executing the transaction.",
        terminal: false,
      };

    case "COMMITTING":
    case "APPEAL_COMMITTING":
      return {
        phase: "validating",
        label: "Validators deciding",
        detail: nondet
          ? "Each validator is re-deriving the outcome independently, under a different " +
            "framing from the leader's, and committing its vote."
          : "Validators are checking the leader's result and committing their votes.",
        terminal: false,
      };

    case "REVEALING":
    case "APPEAL_REVEALING":
      return {
        phase: "revealing",
        label: "Revealing votes",
        detail: "Committed votes are being revealed and compared.",
        terminal: false,
      };

    case "READY_TO_FINALIZE":
    case "ACCEPTED":
      return {
        phase: "settled",
        label: "Accepted",
        detail:
          "The panel agreed and the contract's state has changed. " +
          "Transfers settle on finalization.",
        terminal: true,
      };

    case "FINALIZED":
      return {
        phase: "settled",
        label: "Finalized",
        detail: "The transaction is final and any transfers have settled.",
        terminal: true,
      };

    case "UNDETERMINED":
      return {
        phase: "stalled",
        label: "No agreement",
        detail:
          "The panel could not agree on an outcome, so nothing was written. " +
          "This is the consensus rules working: a disputed reading is not ratified.",
        terminal: true,
      };

    case "LEADER_TIMEOUT":
      return {
        phase: "stalled",
        label: "Leader timed out",
        detail: "The leader did not produce a result in time. A rotation may retry it.",
        terminal: false,
      };

    case "VALIDATORS_TIMEOUT":
      return {
        phase: "stalled",
        label: "Validators timed out",
        detail: "The validator panel did not vote in time.",
        terminal: false,
      };

    case "CANCELED":
      return {
        phase: "stalled",
        label: "Canceled",
        detail: "The transaction was canceled and had no effect.",
        terminal: true,
      };

    default:
      // An unrecognised status is shown as itself. This app is not the
      // authority on what the consensus protocol can report, and inventing a
      // friendly label for a status it does not know would hide the fact.
      return {
        phase: "queued",
        label: snapshot.status,
        detail: "The node reported a status this interface does not recognise.",
        terminal: false,
      };
  }
}

/**
 * The vote tally, when there is one worth showing.
 *
 * Returns null rather than "0 of 0" when the node has not reported a round:
 * an empty tally reads as "nobody voted", which is a different claim from
 * "voting has not started".
 */
export function voteTally(snapshot: ConsensusSnapshot): string | null {
  const { validators, votesRevealed, votesCommitted } = snapshot;
  if (validators === null || validators <= 0) return null;
  if (votesRevealed !== null && votesRevealed > 0) {
    return `${votesRevealed} of ${validators} votes revealed`;
  }
  if (votesCommitted !== null && votesCommitted > 0) {
    return `${votesCommitted} of ${validators} votes committed`;
  }
  return `${validators} validators on the panel`;
}

/** Leader rotations remaining, when the node reports them and any are left. */
export function rotationNote(snapshot: ConsensusSnapshot): string | null {
  if (snapshot.rotationsLeft === null) return null;
  if (snapshot.rotationsLeft <= 0) return "No leader rotations remain.";
  return `${snapshot.rotationsLeft} leader rotation${
    snapshot.rotationsLeft === 1 ? "" : "s"
  } remain if this one fails.`;
}
