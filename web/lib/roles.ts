/**
 * Who the viewer is, and whether a case is waiting on them.
 *
 * Roles come from comparing the connected address against the case's on-chain
 * parties. Nothing is inferred from a session, a claim, or a URL.
 */

import { deadlineStatus } from "./time";
import type { CaseRecord, PartyRole, ViewerRole } from "./types";

export function viewerRoleFor(
  record: CaseRecord,
  viewer: string | null,
): ViewerRole {
  if (!viewer) return "observer";
  const address = viewer.toLowerCase();
  if (record.claimant.toLowerCase() === address) return "claimant";
  if (record.respondent.toLowerCase() === address) return "respondent";
  return "observer";
}

/**
 * Which side did not get what it asked for, and may therefore appeal.
 *
 * Mirrors the contract's `_may_appeal`: a decisive outcome leaves one loser; on
 * SPLIT or INSUFFICIENT_EVIDENCE neither side prevailed outright and the
 * contract lets either appeal, represented here as null.
 */
export function losingSideFor(record: CaseRecord): PartyRole | null {
  if (!record.outcome?.known) return null;
  switch (record.outcome.value) {
    case "CLAIMANT":
      return "respondent";
    case "RESPONDENT":
      return "claimant";
    default:
      return null;
  }
}

/**
 * A short, urgent phrase when the case is waiting on this viewer, otherwise
 * null. Deliberately narrow: if everything shouts, nothing does.
 */
export function attentionFor(
  record: CaseRecord,
  role: ViewerRole,
  nowSec: bigint,
): string | null {
  if (role === "observer" || !record.state.known) return null;
  const state = record.state.value;

  if (state === "DRAFT" && role === "respondent") {
    const status = deadlineStatus(record.acceptDeadline, nowSec);
    if (status.kind === "passed") return null;
    return "your bond is due";
  }

  if (state === "DISPUTED" || state === "EVIDENCE") {
    const status = deadlineStatus(record.evidenceDeadline, nowSec);
    if (status.kind === "passed" || status.kind === "none") return null;
    return "filings close soon";
  }

  if (state === "JUDGED") {
    const losing = losingSideFor(record);
    const mayAppeal = losing === null || losing === role;
    if (!mayAppeal) return null;
    const status = deadlineStatus(record.appealDeadline, nowSec);
    if (status.kind === "passed" || status.kind === "none") return null;
    return "appeal window open";
  }

  return null;
}
