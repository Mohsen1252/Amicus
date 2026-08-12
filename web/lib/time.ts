/**
 * Deadlines are chain time. The browser's clock is not, and the gap between
 * them is exactly where a user loses money.
 *
 * The rule: **never claim a window is open when the chain may disagree.** Near a
 * boundary the UI reports "closing" rather than a confident remaining time, and
 * the contract's own `is_judgeable` is preferred over any local arithmetic when
 * it is available.
 */

/**
 * How close to a deadline the UI stops treating it as open.
 *
 * Chosen to cover clock drift on a typical machine plus the time between
 * signing and the transaction being sequenced. A user who submits inside this
 * margin may well be rejected, so they are told they are inside it rather than
 * shown a reassuring "2 minutes left".
 */
export const SKEW_MARGIN_SEC = 90n;

export type DeadlineStatus =
  | { readonly kind: "none" }
  | { readonly kind: "open"; readonly secondsLeft: bigint }
  | { readonly kind: "closing"; readonly secondsLeft: bigint }
  | { readonly kind: "passed"; readonly secondsSince: bigint };

/**
 * Where a deadline stands, from the app's best estimate of chain time.
 *
 * `nowSec` should come from the reading clock adjusted by however far it was
 * from the chain when last observed - see `chainNowSec`.
 */
export function deadlineStatus(deadline: bigint, nowSec: bigint): DeadlineStatus {
  if (deadline === 0n) return { kind: "none" };
  if (nowSec >= deadline) return { kind: "passed", secondsSince: nowSec - deadline };
  const left = deadline - nowSec;
  if (left <= SKEW_MARGIN_SEC) return { kind: "closing", secondsLeft: left };
  return { kind: "open", secondsLeft: left };
}

/**
 * The app's estimate of chain time.
 *
 * Contract records carry chain timestamps, so the most recent one observed
 * gives an offset between the two clocks. Absent that, the local clock is used
 * unadjusted - which is why every boundary decision also carries a margin.
 */
export function chainNowSec(offsetSec: bigint = 0n): bigint {
  return BigInt(Math.floor(Date.now() / 1000)) + offsetSec;
}

/** A duration as a compact, readable countdown. Never negative. */
export function formatDuration(seconds: bigint): string {
  const total = seconds < 0n ? 0n : seconds;
  const days = total / 86400n;
  const hours = (total % 86400n) / 3600n;
  const minutes = (total % 3600n) / 60n;
  const secs = total % 60n;

  if (days > 0n) return `${days}d ${hours}h`;
  if (hours > 0n) return `${hours}h ${minutes}m`;
  if (minutes > 0n) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/**
 * A chain timestamp as an absolute, unambiguous instant.
 *
 * Always UTC with the offset shown: a case file is read by two parties who may
 * be anywhere, and "3:04 PM" means nothing to the other one.
 */
export function formatTimestamp(seconds: bigint): string {
  if (seconds === 0n) return "-";
  const date = new Date(Number(seconds) * 1000);
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** Short form for dense rows. */
export function formatDate(seconds: bigint): string {
  if (seconds === 0n) return "-";
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}
