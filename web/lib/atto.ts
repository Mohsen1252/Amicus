/**
 * Money. Every amount in Amicus is a u256 at atto scale (10^-18).
 *
 * The rule this module exists to enforce: **values are `bigint` from the moment
 * they enter the app to the moment they are turned into a string for display,
 * and nothing computes on a formatted string.** A single atto amount
 * (600 * 10^18) is about 66,000 times `Number.MAX_SAFE_INTEGER`, so any `Number`
 * in the path loses precision silently and produces a payout figure that is
 * merely plausible.
 *
 * Formatting lives here and only here, and it is the last step before render.
 */

export const ATTO_DECIMALS = 18;
const ATTO_SCALE = 10n ** BigInt(ATTO_DECIMALS);

/** Basis points denominator, mirroring BPS_DENOMINATOR in the contract. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * Coerce a contract-sourced integer into a bigint.
 *
 * genlayer-js returns integers differently depending on how the call was made:
 * with `jsonSafeReturn: false` they arrive as real `bigint`, but the default
 * JSON-safe path yields `number` for small values and `string` for anything
 * past 2^53. The contract client always asks for the bigint form, so `number`
 * should never reach here - but this accepts all three shapes and rejects
 * anything lossy, because being wrong about this is a wrong payout figure.
 */
export function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") {
    if (!/^-?\d+$/.test(value.trim())) {
      throw new Error(`${field}: expected an integer, received "${value}"`);
    }
    return BigInt(value.trim());
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${field}: expected an integer, received ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      // Precision is already gone by the time we see it; refusing is the only
      // honest option.
      throw new Error(
        `${field}: ${value} exceeds the safe integer range, so it has already lost precision`,
      );
    }
    return BigInt(value);
  }
  throw new Error(`${field}: expected an integer, received ${typeof value}`);
}

/**
 * The exact decimal string, every digit, no rounding, no separators.
 * This is the figure someone reconciling a payout to the atto needs.
 */
export function formatAttoExact(atto: bigint): string {
  const negative = atto < 0n;
  const magnitude = negative ? -atto : atto;
  const whole = magnitude / ATTO_SCALE;
  const fraction = magnitude % ATTO_SCALE;
  const fractionDigits = fraction.toString().padStart(ATTO_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${fractionDigits}`;
}

/**
 * A readable amount for scanning: trimmed of trailing zeros, and truncated -
 * never rounded - to `maxFractionDigits`.
 *
 * Truncation is deliberate. Rounding 0.9999999 up to 1 in a list of disputed
 * amounts overstates what is at stake, and every truncated value is marked so
 * it cannot be mistaken for the exact figure.
 */
export function formatAttoShort(atto: bigint, maxFractionDigits = 6): string {
  const exact = formatAttoExact(atto);
  const [whole, fraction = ""] = exact.split(".");
  const kept = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  const truncated = fraction.slice(maxFractionDigits).replace(/0+$/, "") !== "";
  if (kept === "") return truncated ? `${whole}…` : whole;
  return `${whole}.${kept}${truncated ? "…" : ""}`;
}

/** True when the short form hides digits, so the UI can say so. */
export function isTruncated(atto: bigint, maxFractionDigits = 6): boolean {
  const [, fraction = ""] = formatAttoExact(atto).split(".");
  return fraction.slice(maxFractionDigits).replace(/0+$/, "") !== "";
}

export type ParseAmountResult =
  | { readonly ok: true; readonly atto: bigint }
  | { readonly ok: false; readonly error: string };

/**
 * Parse user input into atto at the input boundary, so nothing downstream ever
 * sees a decimal string. Handles empty input, stray separators, and more
 * decimal places than the scale can represent.
 *
 * Never uses parseFloat: "0.1" as a float is not 0.1, and at atto scale that
 * difference is 5,551,115,123,125,782 atto.
 */
export function parseAmountToAtto(input: string): ParseAmountResult {
  const text = input.trim().replace(/,/g, "");
  if (text === "") return { ok: false, error: "Enter an amount." };
  if (!/^\d*(\.\d*)?$/.test(text)) {
    return { ok: false, error: "Use digits and a single decimal point." };
  }
  const [wholeText = "", fractionText = ""] = text.split(".");
  if (wholeText === "" && fractionText === "") {
    return { ok: false, error: "Enter an amount." };
  }
  if (fractionText.length > ATTO_DECIMALS) {
    return {
      ok: false,
      error: `At most ${ATTO_DECIMALS} decimal places; ${fractionText.length} given.`,
    };
  }
  const whole = wholeText === "" ? 0n : BigInt(wholeText);
  const fraction =
    fractionText === "" ? 0n : BigInt(fractionText.padEnd(ATTO_DECIMALS, "0"));
  return { ok: true, atto: whole * ATTO_SCALE + fraction };
}

/**
 * Basis points as a percentage string, for display only.
 *
 * The value is derived from the contract's own `fee_bps`; it is a restatement
 * of a fact the contract holds, not a prediction of any amount.
 */
export function formatBps(bps: bigint): string {
  const whole = bps / 100n;
  const hundredths = bps % 100n;
  if (hundredths === 0n) return `${whole}%`;
  return `${whole}.${hundredths.toString().padStart(2, "0").replace(/0$/, "")}%`;
}
