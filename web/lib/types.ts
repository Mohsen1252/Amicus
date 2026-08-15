/**
 * The data model, mirroring what the contract's view methods actually return.
 *
 * Every string constant here is copied from contracts/amicus.py, not inferred.
 * States and outcomes are closed sets: a value outside them is surfaced as
 * unknown rather than falling through to something that renders as normal.
 */

/** Mirrors STATE_* in the contract. */
export const CASE_STATES = [
  "DRAFT",
  "ACTIVE",
  "RELEASED",
  "DISPUTED",
  "EVIDENCE",
  "JUDGED",
  "APPEALED",
  "FINAL",
  "PAID",
  "EXPIRED",
] as const;
export type CaseState = (typeof CASE_STATES)[number];

/** Mirrors OUTCOME_* in the contract. Empty string means "not yet judged". */
export const OUTCOMES = [
  "CLAIMANT",
  "RESPONDENT",
  "SPLIT",
  "INSUFFICIENT_EVIDENCE",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Mirrors FETCH_* in the contract. */
export const FETCH_STATUSES = ["OK", "UNREACHABLE", "EXCLUDED"] as const;
export type FetchStatus = (typeof FETCH_STATUSES)[number];

export type PartyRole = "claimant" | "respondent";

/** How the viewer relates to a case. Derived from on-chain addresses only. */
export type ViewerRole = PartyRole | "observer";

/** A value the contract produced that this app does not recognise. */
export type Unknown<T> = { readonly known: false; readonly raw: string } | {
  readonly known: true;
  readonly value: T;
};

export type CaseRecord = {
  readonly caseId: string;
  readonly claimant: string;
  readonly respondent: string;
  readonly agreementText: string;
  readonly attoAmount: bigint;
  readonly bondAtto: bigint;
  readonly feeBps: bigint;
  readonly state: Unknown<CaseState>;
  readonly createdAt: bigint;
  readonly acceptDeadline: bigint;
  readonly evidenceWindowSec: bigint;
  readonly evidenceDeadline: bigint;
  readonly appealDeadline: bigint;
  readonly outcome: Unknown<Outcome> | null;
  readonly splitBps: bigint;
  readonly paidOut: boolean;
  readonly respondentBonded: boolean;
  readonly appellant: PartyRole | null;
  readonly appealBondAtto: bigint;
  readonly originalOutcome: Unknown<Outcome> | null;
  readonly claimantTampered: boolean;
  readonly respondentTampered: boolean;
  readonly judgmentCount: bigint;
};

/** One evidence filing, as stored by submit_evidence and read by get_evidence. */
export type EvidenceRecord = {
  readonly caseId: string;
  readonly submitter: string;
  readonly role: PartyRole;
  readonly statement: string;
  readonly urls: readonly string[];
  readonly timestamp: bigint;
  /** Merged in by the contract's view from the case, not stored on the filing. */
  readonly tampered: boolean;
};

/** One fetched URL and what the contract managed to do with it. */
export type FetchOutcome = {
  readonly url: string;
  readonly side: PartyRole | null;
  readonly status: Unknown<FetchStatus>;
  readonly errorClass: string;
  readonly detail: string;
  readonly chars: bigint;
};

/** One judgment or appeal judgment. Append-only in the contract. */
export type JudgmentRecord = {
  readonly caseId: string;
  readonly stage: "judgment" | "appeal" | string;
  readonly outcome: Unknown<Outcome>;
  readonly splitBps: bigint;
  readonly rationale: string;
  readonly citations: readonly string[];
  readonly fetches: readonly FetchOutcome[];
  readonly tampered: boolean;
  readonly claimantTampered: boolean;
  readonly respondentTampered: boolean;
  readonly agreementTampered: boolean;
  readonly timestamp: bigint;
};

/** The distribution the contract recorded when it settled. */
export type PayoutRecord = {
  readonly caseId: string;
  readonly claimantAtto: bigint;
  readonly respondentAtto: bigint;
  readonly ownerAtto: bigint;
  readonly escrowAtto: bigint;
  readonly outcome: string;
  readonly timestamp: bigint;
};

export type ContractStats = {
  readonly owner: string;
  readonly feeBps: bigint;
  readonly totalCases: bigint;
  readonly totalDisputes: bigint;
  readonly totalPaid: bigint;
};

/** Human labels. The contract's own vocabulary, expanded but not reinterpreted. */
export const STATE_LABELS: Record<CaseState, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  RELEASED: "Released",
  DISPUTED: "Disputed",
  EVIDENCE: "Evidence",
  JUDGED: "Judged",
  APPEALED: "Appealed",
  FINAL: "Final",
  PAID: "Paid",
  EXPIRED: "Expired",
};

export const STATE_DESCRIPTIONS: Record<CaseState, string> = {
  DRAFT: "Proposed by the claimant. Waiting for the respondent to post a matching bond.",
  ACTIVE: "Both parties have bonded. The claimant can release the funds, and either can open a dispute.",
  RELEASED: "Settled cooperatively. Waiting for the distribution to be executed.",
  DISPUTED: "A dispute is open. Both parties may file a statement until the deadline.",
  EVIDENCE: "Filings are open. Both parties may file until the deadline.",
  JUDGED: "The panel has ruled. The losing party may appeal until the deadline.",
  APPEALED: "Under appeal. A second panel will rehear the case.",
  FINAL: "The appeal has been decided. No further appeal is possible.",
  PAID: "The distribution has been executed.",
  EXPIRED: "The draft was never accepted and the claimant's deposit was returned.",
};

export const OUTCOME_LABELS: Record<Outcome, string> = {
  CLAIMANT: "For the claimant",
  RESPONDENT: "For the respondent",
  SPLIT: "Split",
  INSUFFICIENT_EVIDENCE: "Insufficient evidence",
};

export const OUTCOME_DESCRIPTIONS: Record<Outcome, string> = {
  CLAIMANT: "The panel found the agreement and the evidence supported the claimant.",
  RESPONDENT: "The panel found the agreement and the evidence supported the respondent.",
  SPLIT: "The panel found the agreement was partly performed.",
  INSUFFICIENT_EVIDENCE:
    "The panel found the evidence did not establish either case. Nothing changed hands.",
};

export const FETCH_STATUS_LABELS: Record<FetchStatus, string> = {
  OK: "Retrieved",
  UNREACHABLE: "Could not be retrieved",
  EXCLUDED: "Excluded for tampering",
};

export const FETCH_STATUS_MEANINGS: Record<FetchStatus, string> = {
  OK: "The contract fetched this page and the panel read it.",
  UNREACHABLE:
    "The contract could not fetch this page. The panel was told it establishes nothing.",
  EXCLUDED:
    "This page tried to instruct the panel. Its contents were withheld and it supported no finding.",
};
