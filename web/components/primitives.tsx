"use client";

/**
 * The small pieces every view is built from.
 *
 * Two rules run through all of them:
 *  - money is `bigint` until the moment it becomes a string here
 *  - state and outcome are never carried by colour alone; each has a word
 */

import { formatAttoExact, formatAttoShort, isTruncated } from "@/lib/atto";
import { formatDuration, formatTimestamp, type DeadlineStatus } from "@/lib/time";
import {
  OUTCOME_LABELS,
  STATE_LABELS,
  type CaseState,
  type Outcome,
  type Unknown,
} from "@/lib/types";
import { shortenAddress, spellAddress } from "@/lib/untrusted";

/**
 * An address, monospaced and elided, with the full value available on demand
 * and a screen-reader label that is spoken in groups rather than as one
 * forty-character word.
 */
export function AddressText({
  address,
  label,
}: {
  address: string;
  label?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      {label ? <span className="text-ink-faint">{label}</span> : null}
      <span
        className="font-mono text-[0.8125rem] text-ink"
        title={address}
        aria-label={spellAddress(address)}
      >
        {shortenAddress(address)}
      </span>
    </span>
  );
}

/**
 * An amount at atto scale.
 *
 * The short form is truncated, never rounded, and marked when digits are
 * hidden. The exact figure is always reachable - `title` for pointers, and the
 * `exact` variant renders every digit inline for reconciliation.
 */
export function Amount({
  atto,
  exact = false,
  className = "",
}: {
  atto: bigint;
  exact?: boolean;
  className?: string;
}) {
  const full = formatAttoExact(atto);
  if (exact) {
    return (
      <span className={`font-mono text-[0.8125rem] tabular-nums ${className}`}>
        {full}
      </span>
    );
  }
  const short = formatAttoShort(atto);
  return (
    <span
      className={`font-mono tabular-nums ${className}`}
      title={`${full} (exact)`}
    >
      {short}
      {isTruncated(atto) ? (
        <span className="sr-only"> truncated for display; exact value {full}</span>
      ) : null}
    </span>
  );
}

/** The exact figure, labelled as such, for the places that must show it. */
export function ExactAmount({ atto }: { atto: bigint }) {
  return (
    <span className="block font-mono text-xs text-ink-faint tabular-nums">
      {formatAttoExact(atto)} exact
    </span>
  );
}

const STATE_TONE: Record<CaseState, string> = {
  DRAFT: "border-rule-strong text-ink-muted",
  ACTIVE: "border-accent text-accent",
  RELEASED: "border-accent text-accent",
  DISPUTED: "border-rule-strong text-ink",
  EVIDENCE: "border-rule-strong text-ink",
  JUDGED: "border-rule-strong text-ink",
  APPEALED: "border-rule-strong text-ink",
  FINAL: "border-rule-strong text-ink",
  PAID: "border-rule text-ink-muted",
  EXPIRED: "border-rule text-ink-muted",
};

/**
 * A case state. Always the word; colour only reinforces it.
 *
 * An unrecognised state is shown as unrecognised rather than rendered as if it
 * were ordinary - the contract may have been upgraded past this build.
 */
export function StateBadge({ state }: { state: Unknown<CaseState> }) {
  if (!state.known) {
    return (
      <span className="stamp border border-flag px-1.5 py-0.5 text-flag">
        Unrecognised: {state.raw || "empty"}
      </span>
    );
  }
  return (
    <span
      className={`stamp border px-1.5 py-0.5 ${STATE_TONE[state.value]}`}
    >
      {STATE_LABELS[state.value]}
    </span>
  );
}

/** An outcome, in the contract's vocabulary. Never coloured as good or bad. */
export function OutcomeText({
  outcome,
  className = "",
}: {
  outcome: Unknown<Outcome>;
  className?: string;
}) {
  if (!outcome.known) {
    return (
      <span className={`text-flag ${className}`}>
        Unrecognised outcome: {outcome.raw || "empty"}
      </span>
    );
  }
  return <span className={className}>{OUTCOME_LABELS[outcome.value]}</span>;
}

/** A chain timestamp. Absolute, UTC, monospaced. */
export function Timestamp({ seconds }: { seconds: bigint }) {
  return (
    <time className="font-mono text-xs text-ink-faint">
      {formatTimestamp(seconds)}
    </time>
  );
}

/**
 * A deadline as a live countdown.
 *
 * Inside the skew margin it stops reporting a confident remaining time and says
 * the window is closing, because the chain's clock is the authority and the
 * browser's is not. A user who submits in that band may be rejected, and they
 * are told so before they start writing rather than after they sign.
 */
export function Countdown({
  status,
  openLabel = "left",
}: {
  status: DeadlineStatus;
  openLabel?: string;
}) {
  if (status.kind === "none") return <span className="text-ink-faint">-</span>;
  if (status.kind === "passed") {
    return (
      <span className="text-ink-muted">
        closed {formatDuration(status.secondsSince)} ago
      </span>
    );
  }
  if (status.kind === "closing") {
    return (
      <span className="text-flag">
        closing now - too late to rely on
      </span>
    );
  }
  return (
    <span className="font-mono tabular-nums">
      {formatDuration(status.secondsLeft)} {openLabel}
    </span>
  );
}

/** A labelled fact in a definition list. */
export function Fact({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="py-2">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
      {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}
