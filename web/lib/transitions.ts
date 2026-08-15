/**
 * A mirror of the contract's TRANSITIONS and ACTORS constants.
 *
 * This is not a state machine. The frontend never decides what may happen; the
 * contract does, and it will reject anything this table gets wrong. The table
 * exists so the UI can *explain* what is available and why, and so an action
 * that would certainly revert is not presented as if it might work.
 *
 * Because the contract is the authority, availability here is advisory: actions
 * are still submitted, and a rejection is surfaced with the contract's own
 * reason. The one thing the UI does structurally is remove `appeal` once a case
 * has been appealed - one level means one, and a disabled control with a
 * tooltip would imply otherwise.
 *
 * Copied from contracts/amicus.py. If that table changes, change this one.
 */

import type { CaseState, PartyRole, ViewerRole } from "./types";

export type ActionName =
  | "accept_case"
  | "release"
  | "open_dispute"
  | "submit_evidence"
  | "judge"
  | "appeal"
  | "judge_appeal"
  | "payout";

/** Who the contract permits, per its ACTORS constant. */
type Actor = "claimant" | "respondent" | "either_party" | "loser" | "anyone";

type Transition = {
  readonly from: readonly CaseState[];
  readonly to: CaseState;
  readonly actor: Actor;
  readonly label: string;
  /** What the action does, in the user's terms. */
  readonly summary: string;
  /** Stated before signing. Every one of these is irreversible. */
  readonly consequence: string;
  readonly payable: boolean;
};

export const TRANSITIONS: Record<ActionName, Transition> = {
  accept_case: {
    from: ["DRAFT"],
    to: "ACTIVE",
    actor: "respondent",
    label: "Accept and post bond",
    summary: "Match the claimant's bond and put the agreement into effect.",
    consequence:
      "Your bond leaves your wallet now. From this point the funds can only move by " +
      "cooperative release or by a panel's decision.",
    payable: true,
  },
  release: {
    from: ["ACTIVE"],
    to: "RELEASED",
    // Claimant-only: release pays the amount to the respondent, so only the
    // claimant (whose funds move) may authorize it. A respondent-initiated
    // release would be an unauthorized taking of the claimant's escrow, which
    // the contract now rejects.
    actor: "claimant",
    label: "Release cooperatively",
    summary: "Settle without a dispute: you send the amount to the respondent, both bonds return.",
    consequence:
      "This ends the case. The amount at stake goes to the respondent and no fee is charged. " +
      "It cannot be undone or disputed afterwards.",
    payable: false,
  },
  open_dispute: {
    from: ["ACTIVE"],
    to: "DISPUTED",
    actor: "either_party",
    label: "Open a dispute",
    summary: "Start the evidence window so both sides can file a statement.",
    consequence:
      "This starts a deadline that cannot be extended or cancelled. Once it passes, anyone " +
      "can send the case to a panel, and the panel's decision moves the money.",
    payable: false,
  },
  submit_evidence: {
    from: ["DISPUTED", "EVIDENCE"],
    to: "EVIDENCE",
    actor: "either_party",
    label: "File a statement",
    summary: "Submit your account of the dispute and any supporting links.",
    consequence:
      "Your statement is stored on chain permanently and publicly. The other party can read " +
      "it. It cannot be edited, withdrawn or deleted, and you may file only once.",
    payable: false,
  },
  judge: {
    from: ["DISPUTED", "EVIDENCE"],
    to: "JUDGED",
    actor: "anyone",
    label: "Send to the panel",
    summary: "Advance the case: the contract fetches the cited pages and a panel rules.",
    consequence:
      "This makes the contract fetch every submitted link and run the panel now. It is not " +
      "reading a stored answer. Anyone may do this once the deadline has passed, and the " +
      "result is recorded permanently.",
    payable: false,
  },
  appeal: {
    from: ["JUDGED"],
    to: "APPEALED",
    actor: "loser",
    label: "Appeal",
    summary: "Post a larger bond and have a second panel rehear the case.",
    consequence:
      "The appeal bond leaves your wallet now. There is one level of appeal only: this is the " +
      "last time the case can be reheard. If the rehearing reaches the same outcome, your " +
      "appeal bond goes to the other party.",
    payable: true,
  },
  judge_appeal: {
    from: ["APPEALED"],
    to: "FINAL",
    actor: "anyone",
    label: "Send to the appeal panel",
    summary: "Advance the appeal: a second panel rehears the case under a stricter rubric.",
    consequence:
      "This makes the contract fetch the cited pages again and run the appeal panel now. " +
      "The result is final and recorded permanently.",
    payable: false,
  },
  payout: {
    from: ["RELEASED", "JUDGED", "FINAL", "EXPIRED", "DRAFT"],
    to: "PAID",
    actor: "anyone",
    label: "Execute the distribution",
    summary: "Move the escrow to whoever the contract determined should receive it.",
    consequence:
      "This transfers the funds as the contract has already decided. Anyone may do this. " +
      "Payouts settle when the transaction finalizes, not when it is accepted.",
    payable: false,
  },
};

/**
 * Whether the contract's table permits this action from this state.
 *
 * `payout` from DRAFT reaches the contract's separate `expire_draft` transition,
 * which is why DRAFT appears in its source states.
 */
export function isStatePermitted(action: ActionName, state: CaseState): boolean {
  return TRANSITIONS[action].from.includes(state);
}

/** Whether the contract's ACTORS table permits this viewer. */
export function isActorPermitted(
  action: ActionName,
  viewer: ViewerRole,
  losingSide: PartyRole | null,
): boolean {
  const actor = TRANSITIONS[action].actor;
  switch (actor) {
    case "anyone":
      return true;
    case "claimant":
      return viewer === "claimant";
    case "respondent":
      return viewer === "respondent";
    case "either_party":
      return viewer === "claimant" || viewer === "respondent";
    case "loser":
      // On SPLIT or INSUFFICIENT_EVIDENCE the contract lets either party
      // appeal, which `losingSide` represents as null-but-party.
      return viewer !== "observer" && (losingSide === null || losingSide === viewer);
  }
}
