/**
 * The boundary every contract-sourced value crosses before the app trusts it.
 *
 * Two things happen here and nowhere else:
 *   1. integers become `bigint` (see atto.ts for why that is not negotiable)
 *   2. states, outcomes and fetch statuses are checked against closed sets, so
 *      an unrecognised value is carried as explicitly unknown instead of being
 *      quietly rendered as if it were ordinary.
 *
 * Reads are requested with `jsonSafeReturn: false`, which makes genlayer-js
 * return a `Map` with real bigints rather than a plain object with lossy
 * `number`s. `field()` accepts either container so a change in that flag can
 * never turn into silent `undefined`s.
 */

import { toBigInt } from "./atto";
import {
  CASE_STATES,
  FETCH_STATUSES,
  OUTCOMES,
  type CaseRecord,
  type CaseState,
  type ContractStats,
  type EvidenceRecord,
  type FetchOutcome,
  type FetchStatus,
  type JudgmentRecord,
  type Outcome,
  type PartyRole,
  type PayoutRecord,
  type Unknown,
} from "./types";

export class ContractDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractDataError";
  }
}

function field(source: unknown, key: string): unknown {
  if (source instanceof Map) return source.get(key);
  if (source && typeof source === "object") {
    return (source as Record<string, unknown>)[key];
  }
  throw new ContractDataError(
    `expected an object or Map from the contract, received ${typeof source}`,
  );
}

function text(source: unknown, key: string): string {
  const value = field(source, key);
  if (typeof value !== "string") {
    throw new ContractDataError(`${key}: expected a string, received ${typeof value}`);
  }
  return value;
}

function integer(source: unknown, key: string): bigint {
  return toBigInt(field(source, key), key);
}

function flag(source: unknown, key: string): boolean {
  const value = field(source, key);
  if (typeof value !== "boolean") {
    throw new ContractDataError(`${key}: expected a boolean, received ${typeof value}`);
  }
  return value;
}

function closedSet<T extends string>(
  raw: string,
  allowed: readonly T[],
): Unknown<T> {
  return (allowed as readonly string[]).includes(raw)
    ? { known: true, value: raw as T }
    : { known: false, raw };
}

/** Empty string means "no value yet", which is different from unrecognised. */
function optionalClosedSet<T extends string>(
  raw: string,
  allowed: readonly T[],
): Unknown<T> | null {
  return raw === "" ? null : closedSet(raw, allowed);
}

function partyRole(raw: string): PartyRole | null {
  return raw === "claimant" || raw === "respondent" ? raw : null;
}

export function parseCase(source: unknown): CaseRecord {
  return {
    caseId: text(source, "case_id"),
    claimant: text(source, "claimant"),
    respondent: text(source, "respondent"),
    agreementText: text(source, "agreement_text"),
    attoAmount: integer(source, "atto_amount"),
    bondAtto: integer(source, "bond_atto"),
    feeBps: integer(source, "fee_bps"),
    state: closedSet<CaseState>(text(source, "state"), CASE_STATES),
    createdAt: integer(source, "created_at"),
    acceptDeadline: integer(source, "accept_deadline"),
    evidenceWindowSec: integer(source, "evidence_window_sec"),
    evidenceDeadline: integer(source, "evidence_deadline"),
    appealDeadline: integer(source, "appeal_deadline"),
    outcome: optionalClosedSet<Outcome>(text(source, "outcome"), OUTCOMES),
    splitBps: integer(source, "split_bps"),
    paidOut: flag(source, "paid_out"),
    respondentBonded: flag(source, "respondent_bonded"),
    appellant: partyRole(text(source, "appellant")),
    appealBondAtto: integer(source, "appeal_bond_atto"),
    originalOutcome: optionalClosedSet<Outcome>(text(source, "original_outcome"), OUTCOMES),
    claimantTampered: flag(source, "claimant_tampered"),
    respondentTampered: flag(source, "respondent_tampered"),
    judgmentCount: integer(source, "judgment_count"),
  };
}

export function parseStats(source: unknown): ContractStats {
  return {
    owner: text(source, "owner"),
    feeBps: integer(source, "fee_bps"),
    totalCases: integer(source, "total_cases"),
    totalDisputes: integer(source, "total_disputes"),
    totalPaid: integer(source, "total_paid"),
  };
}

/**
 * Evidence and judgments are stored as JSON strings inside DynArray[str], so
 * they arrive as text and are parsed here. A record that will not parse is
 * reported rather than skipped: a missing filing is exactly the kind of gap a
 * party needs to know about.
 */
function parseJson(raw: unknown, what: string): unknown {
  if (typeof raw !== "string") {
    throw new ContractDataError(`${what}: expected a JSON string`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ContractDataError(`${what}: stored record is not valid JSON`);
  }
}

function stringList(value: unknown, key: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ContractDataError(`${key}: expected a list`);
  }
  return value.map((entry) => String(entry));
}

export function parseEvidence(raw: unknown): EvidenceRecord {
  const source = parseJson(raw, "evidence");
  const role = partyRole(text(source, "role"));
  if (role === null) {
    throw new ContractDataError(`evidence role: unrecognised value`);
  }
  return {
    caseId: text(source, "case_id"),
    submitter: text(source, "submitter"),
    role,
    statement: text(source, "statement"),
    urls: stringList(field(source, "urls"), "urls"),
    timestamp: integer(source, "timestamp"),
    tampered: flag(source, "tampered"),
  };
}

function parseFetch(source: unknown): FetchOutcome {
  return {
    url: text(source, "url"),
    side: partyRole(text(source, "side")),
    status: closedSet<FetchStatus>(text(source, "status"), FETCH_STATUSES),
    errorClass: text(source, "error_class"),
    detail: text(source, "detail"),
    chars: integer(source, "chars"),
  };
}

export function parseJudgment(raw: unknown): JudgmentRecord {
  const source = parseJson(raw, "judgment");
  const fetches = field(source, "fetches");
  return {
    caseId: text(source, "case_id"),
    stage: text(source, "stage"),
    outcome: closedSet<Outcome>(text(source, "outcome"), OUTCOMES),
    splitBps: integer(source, "split_bps"),
    rationale: text(source, "rationale"),
    citations: stringList(field(source, "citations"), "citations"),
    fetches: Array.isArray(fetches) ? fetches.map(parseFetch) : [],
    tampered: flag(source, "tampered"),
    claimantTampered: flag(source, "claimant_tampered"),
    respondentTampered: flag(source, "respondent_tampered"),
    agreementTampered: flag(source, "agreement_tampered"),
    timestamp: integer(source, "timestamp"),
  };
}

/** get_payout returns "" when the case has not settled. */
export function parsePayout(raw: unknown): PayoutRecord | null {
  if (typeof raw !== "string" || raw === "") return null;
  const source = parseJson(raw, "payout");
  return {
    caseId: text(source, "case_id"),
    claimantAtto: integer(source, "claimant_atto"),
    respondentAtto: integer(source, "respondent_atto"),
    ownerAtto: integer(source, "owner_atto"),
    escrowAtto: integer(source, "escrow_atto"),
    outcome: text(source, "outcome"),
    timestamp: integer(source, "timestamp"),
  };
}

export function parseCaseIds(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new ContractDataError("list_cases: expected a list of case ids");
  }
  return raw.map((entry) => String(entry));
}
