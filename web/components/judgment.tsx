"use client";

/**
 * A judgment, presented so it can be audited rather than merely believed.
 *
 * Shows the outcome, the rationale, which links the panel cited, and - the part
 * that matters most to a party - every submitted URL with what the contract
 * managed to do with it. Someone whose key link failed to load needs to see
 * that, and a reader needs to see that the panel did not read it.
 */

import { formatBps } from "@/lib/atto";
import {
  FETCH_STATUS_LABELS,
  FETCH_STATUS_MEANINGS,
  OUTCOME_DESCRIPTIONS,
  type FetchOutcome,
  type JudgmentRecord,
} from "@/lib/types";
import { OutcomeText } from "./primitives";
import { PanelRationale, TamperFlag, UrlText } from "./untrusted-text";

export function JudgmentEntry({ judgment }: { judgment: JudgmentRecord }) {
  const isAppeal = judgment.stage === "appeal";
  const cited = new Set(judgment.citations);

  return (
    <article className="space-y-4">
      <header className="border border-rule-strong">
        <p className="stamp border-b border-rule-strong bg-leaf px-3 py-1.5 text-ink-muted">
          {isAppeal ? "Appeal panel" : "First-instance panel"}
        </p>
        <div className="px-3 py-3">
          <p className="font-serif text-lg text-ink">
            <OutcomeText outcome={judgment.outcome} />
            {judgment.outcome.known && judgment.outcome.value === "SPLIT" ? (
              <span className="ml-2 font-mono text-base text-ink-muted">
                {formatBps(judgment.splitBps)} to the claimant
              </span>
            ) : null}
          </p>
          {judgment.outcome.known ? (
            <p className="mt-1 text-sm text-ink-muted">
              {OUTCOME_DESCRIPTIONS[judgment.outcome.value]}
            </p>
          ) : null}
        </div>
      </header>

      {judgment.tampered ? (
        <TamperFlag detail={tamperDetail(judgment)}>
          The contract recorded manipulation while judging this case.
        </TamperFlag>
      ) : null}

      <PanelRationale text={judgment.rationale} />

      <EvidenceLedger fetches={judgment.fetches} cited={cited} />

      {judgment.citations.length > 0 ? (
        <div>
          <p className="stamp text-stamp">Links the panel relied on</p>
          <ul className="mt-1.5 space-y-1">
            {judgment.citations.map((url) => (
              <li key={url}>
                <UrlText url={url} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-ink-faint">
          The panel cited no links as supporting its decision.
        </p>
      )}
    </article>
  );
}

function tamperDetail(judgment: JudgmentRecord): string {
  const parts: string[] = [];
  if (judgment.claimantTampered) parts.push("the claimant's filing");
  if (judgment.respondentTampered) parts.push("the respondent's filing");
  if (judgment.agreementTampered) parts.push("the registered agreement");
  const excluded = judgment.fetches.filter(
    (fetch) => fetch.status.known && fetch.status.value === "EXCLUDED",
  ).length;
  if (excluded > 0) {
    parts.push(`${excluded} fetched ${excluded === 1 ? "page" : "pages"}`);
  }
  if (parts.length === 0) {
    return "The panel reported manipulation in the material it was given.";
  }
  return `Flagged in ${parts.join(", ")}.`;
}

/**
 * Every submitted URL and its fetch result.
 *
 * This is the audit surface: a party can see their link failed, and a reader can
 * see the panel did not read it.
 */
function EvidenceLedger({
  fetches,
  cited,
}: {
  fetches: readonly FetchOutcome[];
  cited: ReadonlySet<string>;
}) {
  if (fetches.length === 0) {
    return (
      <p className="text-xs text-ink-faint">
        No links were submitted, so the panel decided on the statements alone.
      </p>
    );
  }

  return (
    <div className="border border-rule">
      <p className="stamp border-b border-rule bg-leaf px-3 py-1.5 text-ink-muted">
        What the contract fetched
      </p>
      <ul className="divide-y divide-rule">
        {fetches.map((fetch, index) => (
          <li key={`${fetch.url}-${index}`} className="px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
              <UrlText url={fetch.url} />
              <FetchBadge fetch={fetch} />
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              {fetch.status.known
                ? FETCH_STATUS_MEANINGS[fetch.status.value]
                : "This interface does not recognise the status the contract recorded."}
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              {fetch.side ? `Cited by the ${fetch.side}.` : "Citing party not recorded."}{" "}
              {fetch.detail ? `Contract note: ${fetch.detail}.` : ""}
              {fetch.status.known && fetch.status.value === "OK"
                ? ` ${fetch.chars.toString()} characters were read.`
                : ""}
              {cited.has(fetch.url) ? " The panel cited this page." : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FetchBadge({ fetch }: { fetch: FetchOutcome }) {
  if (!fetch.status.known) {
    return (
      <span className="stamp border border-flag px-1.5 py-0.5 text-flag">
        Unrecognised: {fetch.status.raw || "empty"}
      </span>
    );
  }
  const status = fetch.status.value;
  const tone =
    status === "OK"
      ? "border-rule-strong text-ink-muted"
      : status === "UNREACHABLE"
        ? "border-rule-strong text-ink"
        : "border-flag text-flag";
  return (
    <span className={`stamp shrink-0 border px-1.5 py-0.5 ${tone}`}>
      {FETCH_STATUS_LABELS[status]}
      {fetch.errorClass ? ` ${fetch.errorClass}` : ""}
    </span>
  );
}
