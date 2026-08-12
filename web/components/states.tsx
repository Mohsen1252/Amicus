"use client";

/**
 * Loading, empty and error surfaces.
 *
 * These are per-view rather than one shared spinner, because the situations
 * they describe are not the same situation. A case that has no filings yet, a
 * read that failed, and a signature the user declined are three different
 * things and a person needs to be told which one happened.
 */

import { describeReadError } from "@/lib/contract";

export function LoadingRows({ rows = 3, label = "Reading the chain" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="border-t border-rule">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 border-b border-rule py-5">
          <span className="h-3 w-24 animate-pulse bg-rule" />
          <span className="h-3 w-32 animate-pulse bg-rule" />
          <span className="ml-auto h-3 w-20 animate-pulse bg-rule" />
        </div>
      ))}
    </div>
  );
}

export function LoadingBlock({ label = "Reading the case" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 py-8">
      <span className="sr-only">{label}…</span>
      <span className="block h-3 w-40 animate-pulse bg-rule" />
      <span className="block h-3 w-full animate-pulse bg-rule" />
      <span className="block h-3 w-5/6 animate-pulse bg-rule" />
    </div>
  );
}

export function ErrorPanel({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border border-flag bg-flag-wash p-6" role="alert">
      <p className="stamp text-flag">Read failed</p>
      <p className="mt-2 text-sm text-ink">{title}</p>
      {detail ? (
        <p className="mt-1 font-mono text-xs break-words text-ink-muted">{detail}</p>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 border border-flag px-3 py-1.5 text-sm text-flag hover:bg-flag/10"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * A failed read, reported in the contract's own words.
 *
 * Wraps `ErrorPanel` with the message recovery so no view has to remember that
 * a thrown read error does not carry its own reason. Retry is offered only when
 * retrying could change the answer: the contract's [EXPECTED] refusals are
 * deterministic and will refuse identically forever, so a retry button beside
 * one is an invitation to a loop.
 */
export function ReadError({
  error,
  title,
  onRetry,
}: {
  error: unknown;
  /** Overrides the contract's sentence where the view has more context. */
  title?: string;
  onRetry?: () => void;
}) {
  const failure = describeReadError(error);
  return (
    <ErrorPanel
      title={title ?? failure.message}
      detail={failure.detail ?? undefined}
      onRetry={failure.retryable ? onRetry : undefined}
    />
  );
}

/**
 * A read that failed while readable data is already on screen.
 *
 * Replacing a rendered docket with an error panel because a background refresh
 * was throttled throws away information the user could still act on, and
 * overstates the problem: nothing is wrong with what they are looking at, it is
 * just not being updated at the moment. This annotates instead.
 *
 * Deliberately not the alarm colour. Oxblood in this app means the contract
 * reported tampering and nothing else, and a transient throttle must not
 * borrow that meaning.
 */
export function StaleNotice({ error }: { error: unknown }) {
  const failure = describeReadError(error);
  return (
    <p
      role="status"
      aria-live="polite"
      className="mb-3 inline-flex items-center gap-2 border border-rule-strong bg-leaf px-2.5 py-1"
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-rule-strong"
      />
      <span className="stamp text-ink-muted">
        {failure.rateLimited ? "RPC rate limited - retrying" : "Refresh failed - retrying"}
      </span>
      <span className="text-xs text-ink-faint">Showing the last known state.</span>
    </p>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="border border-dashed border-rule px-4 py-5 text-sm text-ink-muted">
      {children}
    </p>
  );
}
