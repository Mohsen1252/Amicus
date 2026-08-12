/**
 * The only module that talks to the chain.
 *
 * Every read and write in the app goes through a typed function here. No
 * component builds a call by hand, and no component names the contract address.
 *
 * Two API details worth stating because getting either wrong is a money bug:
 *
 *  - Reads pass `jsonSafeReturn: false`. genlayer-js otherwise returns a plain
 *    object where integers are `number` when small and `string` when large; with
 *    the flag off it returns a `Map` with real `bigint`s. Atto amounts are
 *    ~66,000x past Number.MAX_SAFE_INTEGER, so the default path is a silent
 *    precision loss.
 *
 *  - `writeContract` requires `value` and it must be a `bigint`. Non-payable
 *    methods are called with 0n rather than omitting it.
 */

import { createClient } from "genlayer-js";
import type { Address } from "viem";

import { requireConfig } from "./config";
import {
  parseCase,
  parseCaseIds,
  parseEvidence,
  parseJudgment,
  parsePayout,
  parseStats,
} from "./parse";
import type {
  CaseRecord,
  ContractStats,
  EvidenceRecord,
  JudgmentRecord,
  PayoutRecord,
} from "./types";
import type { ActionName } from "./transitions";

/** Mirrors MAX_PAGE_LIMIT in the contract; asking for more is capped there. */
export const MAX_PAGE_LIMIT = 50;

type ReadClient = ReturnType<typeof createClient>;

let readClient: ReadClient | null = null;

/**
 * The read client. Deliberately account-less: browsing cases and judgments is
 * public and must work with no wallet connected.
 */
function getReadClient(): ReadClient {
  if (readClient) return readClient;
  const config = requireConfig();
  readClient = createClient({ chain: config.chain, endpoint: config.rpcUrl });
  return readClient;
}

/** A client bound to a connected account, for writes only. */
export function getWriteClient(account: Address): ReadClient {
  const config = requireConfig();
  return createClient({ chain: config.chain, endpoint: config.rpcUrl, account });
}

/**
 * How long a single read may take before it is treated as failed.
 *
 * Without this a node that accepts the connection and then stalls leaves the
 * view in a loading skeleton indefinitely, which reads as "still working" when
 * it is really "never going to answer". A stalled read must look like a failed
 * read, because that is what it is.
 */
const READ_TIMEOUT_MS = 15_000;

class ReadTimeoutError extends Error {
  constructor(functionName: string) {
    super(
      `The node did not answer ${functionName} within ${READ_TIMEOUT_MS / 1000} seconds.`,
    );
    this.name = "ReadTimeoutError";
  }
}

async function read(functionName: string, args: unknown[]): Promise<unknown> {
  const config = requireConfig();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getReadClient().readContract({
        address: config.contractAddress,
        functionName,
        args: args as never,
        jsonSafeReturn: false,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReadTimeoutError(functionName)), READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchStats(): Promise<ContractStats> {
  return parseStats(await read("get_stats", []));
}

/**
 * One page of case ids, using the contract's own pagination.
 *
 * The contract caps `limit` at MAX_PAGE_LIMIT regardless of what is asked, so
 * this never fetches everything and slices client-side.
 */
export async function fetchCaseIds(
  offset: number,
  limit: number,
): Promise<readonly string[]> {
  const capped = Math.min(Math.max(limit, 0), MAX_PAGE_LIMIT);
  return parseCaseIds(await read("list_cases", [offset, capped]));
}

export async function fetchCase(caseId: string): Promise<CaseRecord> {
  return parseCase(await read("get_case", [caseId]));
}

export async function fetchEvidence(caseId: string): Promise<readonly EvidenceRecord[]> {
  const raw = await read("get_evidence", [caseId]);
  if (!Array.isArray(raw)) return [];
  return raw.map(parseEvidence);
}

export async function fetchJudgments(caseId: string): Promise<readonly JudgmentRecord[]> {
  const raw = await read("get_judgments", [caseId]);
  if (!Array.isArray(raw)) return [];
  return raw.map(parseJudgment);
}

export async function fetchPayout(caseId: string): Promise<PayoutRecord | null> {
  return parsePayout(await read("get_payout", [caseId]));
}

export async function fetchIsJudgeable(caseId: string): Promise<boolean> {
  const raw = await read("is_judgeable", [caseId]);
  return raw === true;
}

/**
 * One part of a case that may have failed on its own.
 *
 * A case detail is five separate reads. Treating them as one all-or-nothing
 * fetch means a single slow view blanks a page whose other four reads
 * succeeded, and the user is told nothing about a case that is mostly right
 * there. Each section reports its own outcome instead.
 */
export type SectionRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

async function tolerate<T>(
  task: Promise<T>,
  fallbackLabel: string,
): Promise<SectionRead<T>> {
  try {
    return { ok: true, value: await task };
  } catch (error) {
    const failure = describeReadError(error);
    return {
      ok: false,
      reason: failure.missing ? `${fallbackLabel} could not be read.` : failure.message,
    };
  }
}

/** Everything one case detail view needs. */
export type CaseBundle = {
  readonly record: CaseRecord;
  readonly evidence: SectionRead<readonly EvidenceRecord[]>;
  readonly judgments: SectionRead<readonly JudgmentRecord[]>;
  readonly payout: PayoutRecord | null;
  /** Chain-side view of whether judging is open, rather than a local clock guess. */
  readonly isJudgeable: boolean;
  /** When this bundle was read, for skew-aware countdowns. */
  readonly readAtMs: number;
};

/**
 * Read a case.
 *
 * The case record is fetched first because it decides what else is worth
 * asking for. That is not just an optimisation:
 *
 * `get_judgments`, `get_judgments_page` and `get_evidence` are declared
 * `@gl.public.view` but call `TreeMap.get_or_insert_default`, which *inserts*
 * when the key is absent - a storage write inside a read-only call. On a case
 * that has no judgments yet the node stalls for about a minute and then fails.
 * Since that is every case before it is judged, calling `get_judgments`
 * unconditionally makes the detail page unusable for the majority of cases.
 *
 * `judgment_count` is on the case record and is authoritative, so when it is
 * zero the answer is known to be the empty list and the call is skipped
 * entirely. Evidence has no equivalent counter, so it is attempted and allowed
 * to fail on its own without taking the page down with it.
 */
export async function fetchCaseBundle(caseId: string): Promise<CaseBundle> {
  const record = await fetchCase(caseId);

  const [evidence, judgments, payout, isJudgeable] = await Promise.all([
    tolerate(fetchEvidence(caseId), "The filings"),
    record.judgmentCount > 0n
      ? tolerate(fetchJudgments(caseId), "The judgments")
      : Promise.resolve<SectionRead<readonly JudgmentRecord[]>>({ ok: true, value: [] }),
    fetchPayout(caseId),
    fetchIsJudgeable(caseId),
  ]);

  return { record, evidence, judgments, payout, isJudgeable, readAtMs: Date.now() };
}

/** A page of cases for the list view, each with the fields the list shows. */
export async function fetchCasePage(
  offset: number,
  limit: number,
): Promise<readonly CaseRecord[]> {
  const ids = await fetchCaseIds(offset, limit);
  return Promise.all(ids.map((id) => fetchCase(id)));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type WriteRequest = {
  readonly action: ActionName;
  readonly caseId: string;
  /** Native value to attach, in atto. 0n for non-payable actions. */
  readonly value: bigint;
  /** Only submit_evidence carries extra arguments. */
  readonly statement?: string;
  readonly urls?: readonly string[];
};

function argsFor(request: WriteRequest): unknown[] {
  if (request.action === "submit_evidence") {
    return [request.caseId, request.statement ?? "", [...(request.urls ?? [])]];
  }
  return [request.caseId];
}

export type WriteResult = {
  readonly hash: string;
};

/**
 * A new agreement. Not a `WriteRequest`: `propose_case` is the one write that
 * has no case id, because it is what creates one. It is absent from the
 * contract's TRANSITIONS table for the same reason, and absent from
 * `lib/transitions.ts` to match.
 */
export type ProposalRequest = {
  readonly respondent: string;
  readonly agreementText: string;
  readonly attoAmount: bigint;
  readonly bondAtto: bigint;
  readonly evidenceWindowSec: bigint;
};

/**
 * What the contract requires to be sent with a proposal: the amount at stake
 * plus the claimant's bond. The contract checks this for exact equality, not a
 * minimum, so it is computed in one place and never re-derived at a call site.
 */
export function proposalValue(request: ProposalRequest): bigint {
  return request.attoAmount + request.bondAtto;
}

export async function submitProposal(
  account: Address,
  request: ProposalRequest,
): Promise<WriteResult> {
  const config = requireConfig();
  const client = getWriteClient(account);
  const hash = await client.writeContract({
    address: config.contractAddress,
    functionName: "propose_case",
    args: [
      request.respondent,
      request.agreementText,
      request.attoAmount,
      request.bondAtto,
      request.evidenceWindowSec,
    ] as never,
    value: proposalValue(request),
  });
  return { hash: String(hash) };
}

/**
 * The id of the case a proposal just created.
 *
 * `propose_case` returns the id, but a return value is not something this app
 * can read back out of a receipt reliably, so the id is resolved the way the
 * integration tests resolve it: the register's last entry, confirmed to be the
 * caller's own draft.
 *
 * Returns null rather than a guess if that confirmation fails - which is what
 * happens if someone else's proposal landed in between. The proposal still
 * succeeded; only the shortcut to it is unavailable, and the docket has it.
 */
export async function findProposedCaseId(claimant: Address): Promise<string | null> {
  const stats = await fetchStats();
  if (stats.totalCases <= 0n) return null;
  const ids = await fetchCaseIds(Number(stats.totalCases) - 1, 1);
  const caseId = ids[0];
  if (!caseId) return null;
  const record = await fetchCase(caseId);
  const isMine = record.claimant.toLowerCase() === claimant.toLowerCase();
  const isDraft = record.state.known && record.state.value === "DRAFT";
  return isMine && isDraft ? caseId : null;
}

/**
 * Submit a case action. Returns as soon as the transaction is submitted; the
 * caller waits for the receipt separately so the UI can report the two stages
 * differently - a rejected signature and a reverted transaction are not the
 * same event.
 */
export async function submitAction(
  account: Address,
  request: WriteRequest,
): Promise<WriteResult> {
  const config = requireConfig();
  const client = getWriteClient(account);
  const hash = await client.writeContract({
    address: config.contractAddress,
    functionName: request.action,
    args: argsFor(request) as never,
    value: request.value,
  });
  return { hash: String(hash) };
}

// ---------------------------------------------------------------------------
// Consensus progress
// ---------------------------------------------------------------------------

/**
 * What the node reports about a transaction still working its way through
 * consensus.
 *
 * Every field here is read off the transaction, not inferred. `judge` and
 * `judge_appeal` make the contract fetch pages and run a model panel, which
 * takes long enough that a button reading "Submitting..." tells the user
 * nothing about whether anything is happening. These are the actual consensus
 * phases, so the UI can report fact rather than animate a guess.
 */
export type ConsensusSnapshot = {
  /** The node's own TransactionStatus, verbatim. */
  readonly status: string;
  /** Validators in the current round, when the node reports a round. */
  readonly validators: number | null;
  readonly votesCommitted: number | null;
  readonly votesRevealed: number | null;
  /** Leader rotations still available before the transaction is undetermined. */
  readonly rotationsLeft: number | null;
};

function readCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(value)) return value.length;
  return null;
}

/**
 * Poll one transaction's consensus state.
 *
 * Uses the account-less read client: watching a transaction is a read, and a
 * user who has disconnected mid-flight should still see how it ended.
 * Returns null rather than throwing, because a failed poll is not a failed
 * transaction and must never be reported as one.
 */
export async function fetchConsensus(hash: string): Promise<ConsensusSnapshot | null> {
  try {
    const client = getReadClient();
    const tx = (await client.getTransaction({
      hash: hash as unknown as Parameters<typeof client.getTransaction>[0]["hash"],
    })) as unknown;
    if (!tx || typeof tx !== "object") return null;
    const record = tx as {
      statusName?: string;
      status?: string | number;
      lastRound?: Record<string, unknown>;
    };
    const status =
      record.statusName ??
      (typeof record.status === "string" ? record.status : null);
    if (!status) return null;
    const round = record.lastRound;
    return {
      status,
      validators: readCount(round?.roundValidators),
      votesCommitted: readCount(round?.votesCommitted),
      votesRevealed: readCount(round?.votesRevealed),
      rotationsLeft: readCount(round?.rotationsLeft),
    };
  } catch {
    return null;
  }
}

export type ExecutionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Wait for a submitted action and report whether the contract accepted it.
 *
 * Acceptance is a lifecycle state, not proof of success: a reverted execution
 * is accepted and finalized perfectly well, and applies no state changes. So
 * this reads the leader receipt and surfaces the contract's own revert reason.
 */
export async function awaitExecution(
  account: Address,
  hash: string,
): Promise<ExecutionOutcome> {
  const client = getWriteClient(account);
  const receipt = (await client.waitForTransactionReceipt({
    // genlayer-js brands a transaction hash as a 66-character string; the value
    // came from writeContract, so the cast restates a fact rather than assuming
    // one.
    hash: hash as unknown as Parameters<
      typeof client.waitForTransactionReceipt
    >[0]["hash"],
    status: "ACCEPTED" as never,
  })) as unknown;
  return readExecution(receipt);
}

function readExecution(receipt: unknown): ExecutionOutcome {
  const leader = leaderReceipt(receipt);
  if (!leader) return { ok: false, reason: "The node returned no execution receipt." };
  if (leader.execution_result === "SUCCESS") return { ok: true };
  return { ok: false, reason: revertReason(leader) };
}

type LeaderReceipt = {
  execution_result?: string;
  result?: { status?: string; payload?: unknown };
  genvm_result?: { stderr?: string };
};

function leaderReceipt(receipt: unknown): LeaderReceipt | null {
  if (!receipt || typeof receipt !== "object") return null;
  const consensus = (receipt as { consensus_data?: { leader_receipt?: unknown } })
    .consensus_data;
  const list = consensus?.leader_receipt;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0] as LeaderReceipt;
}

/**
 * Pull the contract's own message out of a failed receipt.
 *
 * Amicus raises `gl.vm.UserError` with a classification prefix, so the useful
 * text looks like `[EXPECTED] appeal window has closed`. The prefix is stripped
 * for display but the sentence is the contract's, not ours.
 */
function revertReason(leader: LeaderReceipt): string {
  const payload = leader.result?.payload;
  const stderr = leader.genvm_result?.stderr;
  const raw =
    (typeof payload === "string" && payload) ||
    (typeof stderr === "string" && stderr) ||
    "";
  return cleanReason(raw) || "The contract rejected the transaction.";
}

const REASON_PATTERNS = [
  /UserError\(message=['"](.+?)['"]\)/s,
  /\[(?:EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\][^\n]*/,
];

export function cleanReason(raw: string): string {
  for (const pattern of REASON_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      const text = (match[1] ?? match[0]).trim();
      return stripPrefix(text);
    }
  }
  return stripPrefix(raw.trim().split("\n").pop() ?? "");
}

function stripPrefix(text: string): string {
  return text.replace(/^\[(EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\]\s*/, "");
}

// ---------------------------------------------------------------------------
// Read failures
// ---------------------------------------------------------------------------

/**
 * The contract's own message, recovered from a failed read.
 *
 * genlayer-js surfaces a reverted `gen_call` as a viem `InvalidInputRpcError`
 * reading "Missing or invalid parameters. Double check you have provided the
 * correct parameters." That sentence is wrong twice over: the parameters were
 * fine, and it blames the caller for the contract's own deliberate refusal.
 *
 * The real message survives only on the receipt, base64 encoded behind a
 * one-byte status tag:
 *
 *   error.cause.data.receipt.result
 *     = "AVtFWFBFQ1RFRF0gdW5rbm93biBjYXNlOiBjYXNlLTE="
 *     -> "\x01[EXPECTED] unknown case: case-1"
 *
 * Writes have had this treatment all along through `describeWriteError`. Reads
 * had none, so `get_case` on an id that does not exist reported a viem internal
 * and offered a retry that could never succeed.
 */
type FailureReceipt = {
  readonly execution_result?: string;
  readonly result?: string;
};

function failureReceipt(error: unknown): FailureReceipt | null {
  const data = (error as { cause?: { data?: unknown } })?.cause?.data;
  if (!data || typeof data !== "object") return null;
  const receipt = (data as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== "object") return null;
  return receipt as FailureReceipt;
}

/**
 * Decode the receipt's `result` field.
 *
 * `atob` yields one character per byte, which is exactly right here: the
 * contract source is ASCII by construction - genlayer-py hex-encodes it with
 * `code.encode("ascii")` - so every message it can raise is ASCII too, and
 * there is no multi-byte sequence to reassemble.
 *
 * The leading byte is a status tag rather than text, so any leading control
 * bytes are dropped before the message is read.
 */
function decodeReceiptResult(encoded: string): string {
  try {
    return atob(encoded).replace(/^[\x00-\x1f]+/, "");
  } catch {
    // Not valid base64. There is no message to recover, and inventing one would
    // be worse than admitting that.
    return "";
  }
}

/** The classification prefix the contract raised with, if it raised one. */
function errorClassOf(text: string): string | null {
  const match = text.match(/\[(EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\]/);
  return match ? match[1] : null;
}

export type ReadFailure = {
  /** What to tell the user. The contract's own sentence when it gave one. */
  readonly message: string;
  /** Raw detail worth showing beneath it, or null when it adds nothing. */
  readonly detail: string | null;
  /** The contract said this case id does not exist. */
  readonly missing: boolean;
  /** Whether trying again could plausibly succeed. */
  readonly retryable: boolean;
};

/**
 * Turn a failed read into something a person can act on.
 *
 * The distinction that matters is whether retrying is worth offering. A
 * deterministic refusal - [EXPECTED], which is what the contract raises for an
 * unknown case or a bad argument - will refuse identically forever, so a "Try
 * again" button next to it is a lie. A timeout or an unreachable node is worth
 * retrying and is reported as such.
 */
export function describeReadError(error: unknown): ReadFailure {
  if (error instanceof ReadTimeoutError) {
    return {
      message: error.message,
      detail: null,
      missing: false,
      retryable: true,
    };
  }

  const receipt = failureReceipt(error);
  const decoded = receipt?.result ? decodeReceiptResult(receipt.result) : "";
  if (decoded) {
    const errorClass = errorClassOf(decoded);
    const message = cleanReason(decoded);
    return {
      message: message || "The contract refused this read.",
      detail: null,
      missing: /unknown case/i.test(decoded),
      // [EXPECTED] is a deliberate, deterministic refusal: it will refuse the
      // same way every time. Only the transient classes are worth retrying.
      retryable: errorClass === "TRANSIENT" || errorClass === "EXTERNAL",
    };
  }

  const raw = error instanceof Error ? error.message : String(error);
  if (/fetch failed|Failed to fetch|ECONNREFUSED|NetworkError|timeout/i.test(raw)) {
    return {
      message: "Could not reach the node. Check that it is running and reachable.",
      detail: null,
      missing: false,
      retryable: true,
    };
  }

  // Nothing recognisable. Report it as unexplained rather than dressing a viem
  // internal up as an explanation, but keep the raw text available.
  return {
    message: "This could not be read from the contract.",
    detail: raw || null,
    missing: false,
    retryable: true,
  };
}

/**
 * Turn a thrown client error into something a person can act on.
 *
 * Distinguishes the cases that look alike but are not: a signature the user
 * declined, a contract rejection with a stated reason, a wallet on the wrong
 * network, and a node that could not be reached.
 */
export function describeWriteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const details =
    (error as { details?: string })?.details ??
    (error as { cause?: { message?: string } })?.cause?.message ??
    "";
  const combined = `${details}\n${message}`;

  // A write that reverts during submission rather than after it arrives as the
  // same opaque viem error a read does, with the contract's sentence buried in
  // the receipt. Check there first: it is the only place the real reason is.
  const receipt = failureReceipt(error);
  const decoded = receipt?.result ? decodeReceiptResult(receipt.result) : "";
  if (decoded) return cleanReason(decoded);

  if (/User rejected|User denied|rejected the request/i.test(combined)) {
    return "You declined the signature. Nothing was submitted.";
  }
  if (/insufficient funds|insufficient balance/i.test(combined)) {
    return "That account does not hold enough to cover the amount plus fees.";
  }
  if (/chain|network/i.test(combined) && /mismatch|unsupported|wrong/i.test(combined)) {
    return "Your wallet is connected to a different network than this app.";
  }
  if (/UserError|\[(EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\]/.test(combined)) {
    return cleanReason(combined);
  }
  if (/fetch failed|Failed to fetch|ECONNREFUSED|NetworkError/i.test(combined)) {
    return "Could not reach the node. Check that it is running and reachable.";
  }
  return cleanReason(combined) || message;
}
