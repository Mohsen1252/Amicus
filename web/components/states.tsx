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

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="border border-dashed border-rule px-4 py-5 text-sm text-ink-muted">
      {children}
    </p>
  );
}
