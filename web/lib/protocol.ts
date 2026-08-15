/**
 * The contract's own bounds and rules, restated for display.
 *
 * Every value here is copied from a module-level constant in
 * contracts/amicus.py, not inferred and not rounded. The contract keeps its
 * bounds in one place so the cost envelope of a judgment can be read off at a
 * glance; this file exists so the documentation cannot drift from them
 * silently. If a constant changes there, change it here.
 *
 * This is documentation, not validation. Nothing in the app gates on these -
 * the contract does that, and it is the authority.
 */

/** Seconds, mirroring the contract's window constants. */
export const MIN_EVIDENCE_WINDOW_SEC = 3600;
export const MAX_EVIDENCE_WINDOW_SEC = 2_592_000;
export const APPEAL_WINDOW_SEC = 259_200;
export const DRAFT_EXPIRY_SEC = 604_800;

export const APPEAL_BOND_MULTIPLIER = 3;
export const SPLIT_TOLERANCE_BPS = 1500;
export const MAX_FEE_BPS = 1000;
export const BPS_DENOMINATOR = 10_000;

export const MAX_AGREEMENT_CHARS = 4000;
export const MAX_STATEMENT_CHARS = 4000;
export const MAX_URL_CHARS = 512;
export const MAX_URLS_PER_SUBMISSION = 3;
export const MAX_SUBMISSIONS_PER_PARTY = 1;
export const MAX_DOC_CHARS = 6000;
export const MAX_TOTAL_DOC_CHARS = 24_000;
export const MAX_CITATIONS = 8;

export type ParameterRow = {
  readonly name: string;
  readonly value: string;
  /** Why the contract has this bound, in its own reasoning where it gave any. */
  readonly note: string;
};

export type ParameterGroup = {
  readonly title: string;
  readonly rows: readonly ParameterRow[];
};

export const PARAMETER_GROUPS: readonly ParameterGroup[] = [
  {
    title: "Windows and deadlines",
    rows: [
      {
        name: "Draft acceptance",
        value: "7 days",
        note:
          "A draft the respondent never accepts expires, and the claimant's deposit is " +
          "refunded in full. Without this a proposal nobody answered would strand the " +
          "deposit forever.",
      },
      {
        name: "Evidence window",
        value: "1 hour to 30 days",
        note:
          "Chosen by the claimant when proposing, fixed at that moment. The deadline " +
          "itself is derived from chain time when the dispute opens, never from a value " +
          "a caller supplies.",
      },
      {
        name: "Appeal window",
        value: "3 days",
        note:
          "Runs from the judgment. The distribution cannot be executed until it closes, " +
          "so a losing party always has time to escalate.",
      },
    ],
  },
  {
    title: "Bonds and fees",
    rows: [
      {
        name: "Party bond",
        value: "Set by the claimant, matched by the respondent",
        note:
          "Both sides post the same bond. On a decisive outcome the loser's bond goes to " +
          "the winner; on a split, on insufficient evidence, on cooperative release and " +
          "on expiry both bonds come home intact.",
      },
      {
        name: "Appeal bond",
        value: `${APPEAL_BOND_MULTIPLIER}x the party bond`,
        note:
          "Posted by whoever appeals. If the rehearing overturns the outcome the appellant " +
          "gets it back; if it reaches the same outcome the bond goes to the other party.",
      },
      {
        name: "Protocol fee",
        value: `At most ${MAX_FEE_BPS / 100}%`,
        note:
          "Fixed at deployment and never mutable - an owner who could change the fee " +
          "mid-case could change the terms of a live agreement. Charged only where a " +
          "panel actually adjudicated: cooperative release and expiry are free.",
      },
    ],
  },
  {
    title: "What can be filed",
    rows: [
      {
        name: "Agreement text",
        value: `${MAX_AGREEMENT_CHARS.toLocaleString()} characters`,
        note: "Plain language. This text is the contract, and the panel decides against it.",
      },
      {
        name: "Statement",
        value: `${MAX_STATEMENT_CHARS.toLocaleString()} characters, ${MAX_SUBMISSIONS_PER_PARTY} filing per party`,
        note:
          "Stored permanently and publicly, readable by the other party, and it cannot be " +
          "edited or withdrawn.",
      },
      {
        name: "Evidence links",
        value: `${MAX_URLS_PER_SUBMISSION} per filing, https only`,
        note:
          `Up to ${MAX_URL_CHARS} characters each, no whitespace or control characters. ` +
          "The contract fetches each one itself at judging time.",
      },
      {
        name: "Fetched page size",
        value: `${MAX_DOC_CHARS.toLocaleString()} per page, ${MAX_TOTAL_DOC_CHARS.toLocaleString()} in total`,
        note: "Pages are truncated to keep the judging prompt inside a bounded cost.",
      },
    ],
  },
  {
    title: "How the panel must agree",
    rows: [
      {
        name: "Outcome",
        value: "Exact match required",
        note:
          "The decision field gets no tolerance at all. If the leader and a validator " +
          "reach different outcomes, they disagree.",
      },
      {
        name: "Split proportion",
        value: `Within ${SPLIT_TOLERANCE_BPS / 100} percentage points`,
        note:
          "Two honest readings of the same prose routinely land ten-odd points apart while " +
          "agreeing completely on substance. Tighter and honest disagreement about wording " +
          "fails consensus; much wider and a manipulated reading could pass as agreement.",
      },
      {
        name: "Tampering finding",
        value: "Exact match required",
        note:
          "Whether a filing tried to manipulate the reader is a finding about the parties. " +
          "If one panel member saw it and another did not, they did not read the same " +
          "record and must not be treated as agreeing.",
      },
      {
        name: "Rationale and citations",
        value: "Never compared",
        note:
          "They are prose, and prose never matches. Comparing them would guarantee " +
          "consensus failure on wording alone.",
      },
    ],
  },
];

/** One step of the case lifecycle, for the walkthrough. */
export type LifecycleStep = {
  readonly state: string;
  readonly title: string;
  readonly who: string;
  readonly body: string;
};

export const LIFECYCLE: readonly LifecycleStep[] = [
  {
    state: "DRAFT",
    title: "A case is proposed",
    who: "Claimant",
    body:
      "One party writes the agreement in plain language, names the counterparty, sets the " +
      "amount at stake, the bond both sides will post, and how long the evidence window " +
      "should run. They send the amount plus their own bond in the same transaction.",
  },
  {
    state: "ACTIVE",
    title: "The counterparty accepts",
    who: "Respondent",
    body:
      "The respondent posts a matching bond and the agreement is in effect. If they never " +
      "do, the draft expires after 7 days and the claimant is refunded in full.",
  },
  {
    state: "RELEASED",
    title: "Or it simply goes well",
    who: "Claimant",
    body:
      "The claimant can release cooperatively. The amount goes to the respondent, both bonds " +
      "come home, and no fee is charged. Because release pays the respondent, only the " +
      "claimant may authorize it. Most cases should end here.",
  },
  {
    state: "DISPUTED",
    title: "A dispute opens",
    who: "Either party",
    body:
      "Opening a dispute starts the evidence window. The deadline cannot be extended or " +
      "cancelled by anyone, including the person who opened it.",
  },
  {
    state: "EVIDENCE",
    title: "Both sides file",
    who: "Either party",
    body:
      "Each party may file one statement and up to three https links. Silence is not a veto: " +
      "a case can be judged with no evidence at all, so refusing to participate cannot " +
      "freeze the funds.",
  },
  {
    state: "JUDGED",
    title: "The panel rules",
    who: "Anyone",
    body:
      "Once the window closes anyone can send the case to the panel. The contract fetches " +
      "every cited page itself and judges the agreement against what it finds. The outcome " +
      "and the reasoning are recorded permanently.",
  },
  {
    state: "APPEALED",
    title: "The losing side may appeal",
    who: "The losing party",
    body:
      "Within 3 days, whoever lost can post a bond of three times the party bond and have " +
      "the case reheard. There is one level of appeal only.",
  },
  {
    state: "FINAL",
    title: "The appeal is decided",
    who: "Anyone",
    body:
      "A second panel rehears the case from scratch under a stricter rubric: a finding for " +
      "either side must be dispositive, not merely suggestive. Its outcome is final.",
  },
  {
    state: "PAID",
    title: "The money moves",
    who: "Anyone",
    body:
      "Anyone can execute the distribution, so no party can strand the funds by refusing to " +
      "act. The contract asserts conservation before anything moves: the shares must sum to " +
      "exactly what was deposited. Transfers settle on finalization.",
  },
];

/** What each outcome does to the money. Mirrors `_plan_payout`. */
export type OutcomeRule = {
  readonly outcome: string;
  readonly effect: string;
};

export const OUTCOME_RULES: readonly OutcomeRule[] = [
  {
    outcome: "For the claimant",
    effect:
      "The claimant receives the disputed amount less the fee, their own bond, and the " +
      "respondent's bond.",
  },
  {
    outcome: "For the respondent",
    effect:
      "The respondent receives the disputed amount less the fee, their own bond, and the " +
      "claimant's bond.",
  },
  {
    outcome: "Split",
    effect:
      "The disputed amount less the fee is divided by the proportion the panel found. Both " +
      "bonds are returned intact. Rounding dust goes to the respondent's side so the two " +
      "shares always re-add to the exact total.",
  },
  {
    outcome: "Insufficient evidence",
    effect:
      "Nothing changes hands. The disputed amount returns to the claimant who deposited it, " +
      "both bonds come home, and no fee is charged. This is a real finding, not a failure - " +
      "it is the correct answer whenever both cases rest on assertion alone.",
  },
];
