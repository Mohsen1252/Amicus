"use client";

/**
 * The actions available on a case.
 *
 * Availability is derived from the contract's own transition and actor tables,
 * and it is advisory: the contract is the authority, so an action that looks
 * available is still submitted and a rejection is reported with the contract's
 * own words. Hiding a button is not a security control and is not treated as
 * one here.
 *
 * The one structural rule is appeal: once a case has been appealed the action is
 * gone, not disabled. One level means one, and a disabled control implies the
 * possibility of a second.
 *
 * Every action here is irreversible, so every one passes through a confirmation
 * that states what it costs and what it cannot undo before a signature is asked
 * for.
 */

import { useState } from "react";

import { Amount } from "./primitives";
import { ConfirmDialog } from "./confirm-dialog";
import { ConsensusProgress } from "./consensus-progress";
import { useWallet } from "./wallet";
import { isNonDeterministic } from "@/lib/consensus";
import { APPEAL_BOND_MULTIPLIER } from "@/lib/protocol";
import { useSubmitAction } from "@/lib/use-submit-action";
import { losingSideFor } from "@/lib/roles";
import { chainNowSec, deadlineStatus } from "@/lib/time";
import {
  TRANSITIONS,
  isActorPermitted,
  isStatePermitted,
  type ActionName,
} from "@/lib/transitions";
import type { CaseRecord, ViewerRole } from "@/lib/types";

/** Actions offered on the detail screen, in the order a case moves through them. */
const ORDER: readonly ActionName[] = [
  "accept_case",
  "release",
  "open_dispute",
  "judge",
  "appeal",
  "judge_appeal",
  "payout",
];

export function ActionPanel({
  record,
  role,
  isJudgeable,
  hasFiled,
}: {
  record: CaseRecord;
  role: ViewerRole;
  isJudgeable: boolean;
  hasFiled: boolean;
}) {
  const { address, connect } = useWallet();
  const state = record.state.known ? record.state.value : null;
  const losing = losingSideFor(record);

  const available = state
    ? ORDER.filter((action) => {
        // submit_evidence has its own form, so it is not a panel button.
        if (!isStatePermitted(action, state)) return false;
        // One level of appeal: once used, the action does not exist.
        if (action === "appeal" && record.appellant !== null) return false;
        return true;
      })
    : [];

  if (!state) {
    return (
      <section className="border border-flag bg-flag-wash p-3">
        <p className="stamp text-flag">No actions offered</p>
        <p className="mt-2 text-sm text-ink">
          This case is in a state this interface does not recognise, so it will not
          suggest what to do next.
        </p>
      </section>
    );
  }

  if (available.length === 0) {
    return (
      <section className="border border-rule p-3">
        <p className="stamp text-stamp">No actions available</p>
        <p className="mt-2 text-sm text-ink-muted">
          Nothing can be done on this case in its current state.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Actions" className="border border-rule">
      <h2 className="stamp border-b border-rule bg-leaf px-3 py-1.5 text-ink-muted">
        Actions
      </h2>
      <div className="divide-y divide-rule">
        {available.map((action) => (
          <ActionRow
            key={action}
            action={action}
            record={record}
            role={role}
            losing={losing}
            isJudgeable={isJudgeable}
            hasFiled={hasFiled}
            connected={address !== null}
            onConnect={connect}
          />
        ))}
      </div>
      {!address ? (
        <p className="border-t border-rule px-3 py-2 text-xs text-ink-faint">
          Reading this case needs no wallet. Acting on it does.
        </p>
      ) : null}
    </section>
  );
}

function ActionRow({
  action,
  record,
  role,
  losing,
  isJudgeable,
  hasFiled,
  connected,
  onConnect,
}: {
  action: ActionName;
  record: CaseRecord;
  role: ViewerRole;
  losing: ReturnType<typeof losingSideFor>;
  isJudgeable: boolean;
  hasFiled: boolean;
  connected: boolean;
  onConnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { submit, status, error, consensus, reset } = useSubmitAction(record.caseId);
  const meta = TRANSITIONS[action];
  const permitted = isActorPermitted(action, role, losing);
  const gate = timingGate(action, record, isJudgeable);
  const value = valueFor(action, record);

  const blocked = !permitted || gate !== null;

  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm text-ink">{meta.label}</p>
        {value > 0n ? (
          <span className="text-sm">
            <Amount atto={value} className="text-ink" />
            <span className="ml-1 text-xs text-ink-faint">to send</span>
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-ink-muted">{meta.summary}</p>

      {!permitted ? (
        <p className="mt-2 text-xs text-ink-faint">
          {whoMay(action, losing)}
        </p>
      ) : gate ? (
        <p className="mt-2 text-xs text-ink-faint">{gate}</p>
      ) : null}

      {action === "submit_evidence" && hasFiled ? (
        <p className="mt-2 text-xs text-ink-faint">You have already filed once.</p>
      ) : null}

      <div className="mt-2">
        {!connected ? (
          <button
            type="button"
            onClick={onConnect}
            className="border border-rule px-2.5 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
          >
            Connect to act
          </button>
        ) : (
          <button
            type="button"
            disabled={blocked || status === "signing" || status === "waiting"}
            onClick={() => {
              reset();
              setOpen(true);
            }}
            className="border border-accent px-2.5 py-1 text-xs text-accent hover:bg-accent-wash disabled:cursor-not-allowed disabled:border-rule disabled:text-ink-faint"
          >
            {statusLabel(status, meta.label)}
          </button>
        )}
      </div>

      {status === "waiting" ? (
        <ConsensusProgress
          snapshot={consensus}
          nondet={isNonDeterministic(action)}
        />
      ) : null}

      {status === "failed" && error ? (
        <p className="mt-2 border border-flag bg-flag-wash px-2 py-1.5 text-xs text-ink" role="alert">
          {error}
        </p>
      ) : null}
      {status === "done" ? (
        <p className="mt-2 text-xs text-accent" role="status">
          Recorded on chain.
        </p>
      ) : null}

      <ConfirmDialog
        open={open}
        title={meta.label}
        consequence={meta.consequence}
        confirmLabel={meta.label}
        value={value}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setOpen(false);
          await submit({ action, caseId: record.caseId, value });
        }}
      />
    </div>
  );
}

function statusLabel(status: string, label: string): string {
  if (status === "signing") return "Waiting for signature…";
  if (status === "waiting") return "Submitting…";
  return label;
}

/**
 * What the contract requires to be sent with a payable action.
 *
 * The multiplier is imported rather than written here. The contract checks this
 * figure for *exact* equality, so a copy of it that drifted from the one the
 * documentation quotes would either revert every appeal or, worse, quote the
 * user one price and ask them to sign another.
 */
function valueFor(action: ActionName, record: CaseRecord): bigint {
  if (action === "accept_case") return record.bondAtto;
  if (action === "appeal") return record.bondAtto * BigInt(APPEAL_BOND_MULTIPLIER);
  return 0n;
}

/**
 * Timing gates, stated conservatively.
 *
 * Near a deadline the app does not claim the window is open, because the
 * chain's clock decides and the browser's does not. For judging it defers to
 * the contract's own `is_judgeable` rather than to local arithmetic.
 */
function timingGate(
  action: ActionName,
  record: CaseRecord,
  isJudgeable: boolean,
): string | null {
  const now = chainNowSec();

  if (action === "judge") {
    return isJudgeable
      ? null
      : "The contract reports the filing window has not closed yet.";
  }

  if (action === "accept_case") {
    const status = deadlineStatus(record.acceptDeadline, now);
    if (status.kind === "passed") return "The acceptance deadline has passed.";
    if (status.kind === "closing") {
      return "The acceptance deadline is within the margin where the chain may already disagree.";
    }
    return null;
  }

  if (action === "appeal") {
    const status = deadlineStatus(record.appealDeadline, now);
    if (status.kind === "passed") return "The appeal window has closed.";
    if (status.kind === "closing") {
      return "The appeal window is within the margin where the chain may already disagree.";
    }
    return null;
  }

  if (action === "payout" && record.state.known && record.state.value === "JUDGED") {
    const status = deadlineStatus(record.appealDeadline, now);
    if (status.kind !== "passed") {
      return "The distribution waits until the appeal window closes.";
    }
  }

  if (action === "payout" && record.state.known && record.state.value === "DRAFT") {
    const status = deadlineStatus(record.acceptDeadline, now);
    if (status.kind !== "passed") {
      return "A draft can only be refunded once its acceptance deadline has passed.";
    }
  }

  return null;
}

function whoMay(action: ActionName, losing: ReturnType<typeof losingSideFor>): string {
  const actor = TRANSITIONS[action].actor;
  switch (actor) {
    case "claimant":
      return "Only the claimant can do this.";
    case "respondent":
      return "Only the respondent can do this.";
    case "either_party":
      return "Only a party to this case can do this.";
    case "loser":
      return losing
        ? `Only the ${losing} can appeal this outcome.`
        : "Only a party to this case can appeal.";
    case "anyone":
      return "Anyone can do this.";
  }
}
