/**
 * The rules `propose_case` enforces, applied before a signature rather than
 * after one.
 *
 * Every check here exists in contracts/amicus.py and every constant is copied
 * from it. This is not the authority - the contract rejects anything this gets
 * wrong - but a proposal is the one action that costs the full escrow to
 * attempt, so learning the rules from a revert is an expensive way to learn
 * them.
 *
 * The value check is the one worth being exact about: the contract requires the
 * sent value to *equal* amount + bond, not to cover it. An overpayment is
 * rejected, not refunded.
 *
 * Copied from contracts/amicus.py. If those rules change, change these.
 */

import { parseAmountToAtto } from "./atto";
import type { ProposalRequest } from "./contract";

/** Mirrors MAX_AGREEMENT_CHARS. */
export const MAX_AGREEMENT_CHARS = 4000;
/** Mirrors MIN_EVIDENCE_WINDOW_SEC and MAX_EVIDENCE_WINDOW_SEC. */
export const MIN_EVIDENCE_WINDOW_SEC = 3600n;
export const MAX_EVIDENCE_WINDOW_SEC = 2_592_000n;
/** Mirrors DRAFT_EXPIRY_SEC: how long the respondent has to accept. */
export const DRAFT_EXPIRY_SEC = 604_800n;
/** Mirrors MAX_ATTO. */
export const MAX_ATTO = 2n ** 200n;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * The evidence windows offered.
 *
 * A window is a seconds value the contract stores at proposal time and turns
 * into a deadline when a dispute opens, months later perhaps. These are offered
 * as named durations rather than a seconds field: every one is inside the
 * contract's range by construction, and nobody has to be told that 259200 is
 * three days.
 */
export const EVIDENCE_WINDOWS: readonly { seconds: bigint; label: string }[] = [
  { seconds: 3600n, label: "1 hour" },
  { seconds: 86_400n, label: "24 hours" },
  { seconds: 259_200n, label: "3 days" },
  { seconds: 604_800n, label: "7 days" },
  { seconds: 1_209_600n, label: "14 days" },
  { seconds: 2_592_000n, label: "30 days" },
];

/** What the form holds: text as typed, before any of it is money. */
export type ProposalDraft = {
  readonly respondent: string;
  readonly agreementText: string;
  readonly amountInput: string;
  readonly bondInput: string;
  readonly evidenceWindowSec: bigint;
};

export type ProposalField = "respondent" | "agreementText" | "amount" | "bond";

export type ProposalProblems = Partial<Record<ProposalField, string>>;

export type ProposalCheck =
  | { readonly ok: true; readonly request: ProposalRequest; readonly problems: ProposalProblems }
  | { readonly ok: false; readonly problems: ProposalProblems };

/**
 * Check a draft against the contract's rules.
 *
 * Reports every problem at once rather than the first one, and reports nothing
 * about a field the user has not filled in yet - a form that turns red before
 * anything has been typed teaches people to ignore it.
 */
export function checkProposal(
  draft: ProposalDraft,
  claimant: string | null,
): ProposalCheck {
  const problems: ProposalProblems = {};

  const respondent = draft.respondent.trim();
  if (respondent !== "") {
    if (!ADDRESS_PATTERN.test(respondent)) {
      problems.respondent = "Not a 20-byte hex address: 0x followed by 40 hex characters.";
    } else if (respondent.toLowerCase() === ZERO_ADDRESS) {
      problems.respondent = "The contract rejects the zero address as a respondent.";
    } else if (claimant && respondent.toLowerCase() === claimant.toLowerCase()) {
      problems.respondent = "You cannot be both parties to an agreement.";
    }
  }

  // The contract measures the cap against the text as sent, but requires the
  // trimmed text to be non-empty. Both are checked the same way here.
  if (draft.agreementText.length > MAX_AGREEMENT_CHARS) {
    problems.agreementText = `Over the contract's ${MAX_AGREEMENT_CHARS.toLocaleString()}-character limit.`;
  }

  const amount = checkAmount(draft.amountInput);
  if (amount.error) problems.amount = amount.error;

  const bond = checkAmount(draft.bondInput);
  if (bond.error) problems.bond = bond.error;

  const complete =
    respondent !== "" &&
    draft.agreementText.trim() !== "" &&
    draft.amountInput.trim() !== "" &&
    draft.bondInput.trim() !== "";

  if (
    !complete ||
    Object.keys(problems).length > 0 ||
    amount.atto === null ||
    bond.atto === null
  ) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    problems,
    request: {
      respondent,
      agreementText: draft.agreementText,
      attoAmount: amount.atto,
      bondAtto: bond.atto,
      evidenceWindowSec: draft.evidenceWindowSec,
    },
  };
}

/**
 * One amount, parsed to atto and range-checked.
 *
 * Empty input is not a problem to report, only an incomplete draft: the caller
 * distinguishes "not filled in yet" from "filled in wrongly".
 */
function checkAmount(input: string): {
  readonly atto: bigint | null;
  readonly error: string | null;
} {
  if (input.trim() === "") return { atto: null, error: null };
  const parsed = parseAmountToAtto(input);
  if (!parsed.ok) return { atto: null, error: parsed.error };
  if (parsed.atto <= 0n) return { atto: null, error: "Must be more than zero." };
  if (parsed.atto > MAX_ATTO) {
    return { atto: null, error: "Beyond the largest amount the contract accepts." };
  }
  return { atto: parsed.atto, error: null };
}

/** The named duration for a window, for restating a choice back to the user. */
export function windowLabel(seconds: bigint): string {
  return (
    EVIDENCE_WINDOWS.find((option) => option.seconds === seconds)?.label ??
    `${seconds} seconds`
  );
}
