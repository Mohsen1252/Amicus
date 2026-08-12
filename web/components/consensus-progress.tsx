"use client";

/**
 * What the panel is doing right now.
 *
 * Shown while a transaction is in flight. For `judge` and `judge_appeal` this
 * is the difference between a UI that looks hung and one that shows a leader
 * fetching pages while validators re-derive the outcome independently.
 *
 * The phases are a fixed sequence because the protocol's are, and the current
 * one is marked. What is deliberately absent is a percentage or an estimate:
 * leaders can rotate and the sequence can restart, so any bar drawn here would
 * eventually run backwards. Each phase is either reached, current, or not yet.
 */

import {
  describeConsensus,
  rotationNote,
  voteTally,
  type ConsensusPhase,
} from "@/lib/consensus";
import type { ConsensusSnapshot } from "@/lib/contract";

/** The order the protocol moves through. "stalled" is not a step; it interrupts. */
const SEQUENCE: readonly { phase: ConsensusPhase; label: string }[] = [
  { phase: "queued", label: "Queued" },
  { phase: "executing", label: "Leader" },
  { phase: "validating", label: "Validators" },
  { phase: "revealing", label: "Reveal" },
  { phase: "settled", label: "Accepted" },
];

export function ConsensusProgress({
  snapshot,
  nondet,
  /** Shown before the node has reported anything about the transaction. */
  pendingLabel = "Submitting to the network…",
}: {
  snapshot: ConsensusSnapshot | null;
  nondet: boolean;
  pendingLabel?: string;
}) {
  if (!snapshot) {
    return (
      <p role="status" aria-live="polite" className="mt-2 text-xs text-ink-muted">
        {pendingLabel}
      </p>
    );
  }

  const stage = describeConsensus(snapshot, nondet);
  const tally = voteTally(snapshot);
  const rotations = stage.phase === "stalled" ? rotationNote(snapshot) : null;
  const reached = SEQUENCE.findIndex((step) => step.phase === stage.phase);
  const stalled = stage.phase === "stalled";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-2 border px-3 py-2.5 ${
        stalled ? "border-flag bg-flag-wash" : "border-rule bg-leaf"
      }`}
    >
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {SEQUENCE.map((step, index) => {
          const isCurrent = !stalled && index === reached;
          const isPast = !stalled && reached > index;
          return (
            <li key={step.phase} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden className="text-rule-strong">
                  ·
                </span>
              ) : null}
              <span
                className={`stamp ${
                  isCurrent
                    ? "text-accent"
                    : isPast
                      ? "text-ink-muted"
                      : "text-ink-faint/60"
                }`}
              >
                {isCurrent ? (
                  <span
                    aria-hidden
                    className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent align-middle"
                  />
                ) : null}
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>

      <p className={`mt-1.5 text-sm ${stalled ? "text-flag" : "text-ink"}`}>
        {stage.label}
      </p>
      <p className="mt-0.5 text-xs text-ink-muted">{stage.detail}</p>

      {tally ? (
        <p className="mt-1 font-mono text-xs text-ink-faint tabular-nums">{tally}</p>
      ) : null}
      {rotations ? (
        <p className="mt-1 text-xs text-ink-faint">{rotations}</p>
      ) : null}
    </div>
  );
}
