"use client";

/**
 * Filing a statement.
 *
 * The validation here mirrors the contract's exactly, so a party learns the
 * rules from the form rather than from a revert: at most three links, https
 * only, a statement under the contract's character cap, one filing per party.
 * The numbers are the contract's own constants, restated in one place below.
 *
 * The deadline is a live countdown, and input stops when it passes rather than
 * letting someone write for ten minutes and then eat a rejection. Inside the
 * skew margin the form says so and keeps going - it does not claim the window
 * is open when the chain may already disagree.
 */

import { useEffect, useMemo, useState } from "react";

import { chainNowSec, deadlineStatus, formatTimestamp } from "@/lib/time";
import {
  MAX_STATEMENT_CHARS,
  MAX_URLS_PER_SUBMISSION,
  MAX_URL_CHARS,
} from "@/lib/protocol";
import { ConsensusProgress } from "./consensus-progress";
import { useSubmitAction } from "@/lib/use-submit-action";
import type { CaseRecord, ViewerRole } from "@/lib/types";
import { ConfirmDialog } from "./confirm-dialog";
import { Countdown } from "./primitives";
import { useWallet } from "./wallet";

/**
 * The contract's own caps, imported rather than restated.
 *
 * These drive what the form accepts, and the contract rejects anything past
 * them. A local copy that drifted would let someone write four thousand
 * characters into a box that the chain refuses.
 */
const MAX_URLS = MAX_URLS_PER_SUBMISSION;

type UrlProblem = { readonly index: number; readonly message: string };

export function EvidenceForm({
  record,
  role,
  hasFiled,
}: {
  record: CaseRecord;
  role: ViewerRole;
  hasFiled: boolean;
}) {
  const { address, connect } = useWallet();
  const { submit, status, error, consensus, reset } = useSubmitAction(record.caseId);
  const [statement, setStatement] = useState("");
  const [urls, setUrls] = useState<string[]>([""]);
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => chainNowSec());

  // One timer for the countdown; the form does not refetch to tick.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(chainNowSec()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const deadline = deadlineStatus(record.evidenceDeadline, now);
  const closed = deadline.kind === "passed";
  const closing = deadline.kind === "closing";

  const filled = useMemo(() => urls.map((u) => u.trim()).filter((u) => u !== ""), [urls]);
  const urlProblems = useMemo(() => validateUrls(urls), [urls]);
  const statementTooLong = statement.length > MAX_STATEMENT_CHARS;
  const empty = statement.trim() === "" && filled.length === 0;

  if (role === "observer") {
    return (
      <Panel>
        <p className="text-sm text-ink-muted">
          Only the claimant or the respondent can file a statement on this case.
        </p>
      </Panel>
    );
  }

  if (hasFiled) {
    return (
      <Panel>
        <p className="text-sm text-ink">You have filed your statement.</p>
        <p className="mt-1 text-sm text-ink-muted">
          The contract accepts one filing per party, and it cannot be edited or
          withdrawn. Your filing appears in the record above.
        </p>
      </Panel>
    );
  }

  if (closed) {
    return (
      <Panel>
        <p className="text-sm text-ink">Filings closed.</p>
        <p className="mt-1 text-sm text-ink-muted">
          The window closed at {formatTimestamp(record.evidenceDeadline)}. The case can
          now be sent to the panel by anyone, and it will be judged on whatever was
          filed.
        </p>
      </Panel>
    );
  }

  const blocked = empty || statementTooLong || urlProblems.length > 0;

  return (
    <Panel>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-serif text-lg text-ink">File your statement</h2>
        <p className="text-sm">
          <span className="text-ink-faint">Filings close in </span>
          <Countdown status={deadline} />
        </p>
      </div>

      {closing ? (
        <p className="mt-3 border border-flag bg-flag-wash px-3 py-2 text-sm text-ink">
          You are inside the margin where the chain&rsquo;s clock may already have passed
          the deadline. A filing sent now may be rejected.
        </p>
      ) : null}

      <p className="mt-3 text-sm text-ink-muted">
        You may file once. What you write is stored on chain permanently and publicly, and
        the other party can read it.
      </p>

      <div className="mt-5">
        <label htmlFor="statement" className="block text-sm text-ink">
          Your account of the dispute
        </label>
        <textarea
          id="statement"
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          rows={8}
          maxLength={MAX_STATEMENT_CHARS}
          aria-describedby="statement-help"
          className="mt-1.5 w-full border border-rule bg-leaf px-3 py-2 font-serif text-[0.9375rem] text-ink"
        />
        <p id="statement-help" className="mt-1 flex justify-between text-xs">
          <span className="text-ink-faint">
            Plain text. Formatting is not interpreted.
          </span>
          <span
            className={
              statement.length > MAX_STATEMENT_CHARS * 0.9 ? "text-flag" : "text-ink-faint"
            }
          >
            {statement.length.toLocaleString()} / {MAX_STATEMENT_CHARS.toLocaleString()}
          </span>
        </p>
      </div>

      <fieldset className="mt-5">
        <legend className="text-sm text-ink">
          Links to evidence ({MAX_URLS} at most)
        </legend>
        <p className="mt-1 text-xs text-ink-faint">
          The contract fetches each of these itself when the case is judged. https only.
        </p>
        <div className="mt-2 space-y-2">
          {urls.map((url, index) => {
            const problem = urlProblems.find((item) => item.index === index);
            return (
              <div key={index}>
                <div className="flex gap-2">
                  <input
                    type="url"
                    inputMode="url"
                    value={url}
                    aria-label={`Evidence link ${index + 1}`}
                    aria-invalid={problem !== undefined}
                    placeholder="https://"
                    onChange={(event) => {
                      const next = [...urls];
                      next[index] = event.target.value;
                      setUrls(next);
                    }}
                    className="min-w-0 flex-1 border border-rule bg-leaf px-3 py-2 font-mono text-[0.8125rem] text-ink"
                  />
                  {urls.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setUrls(urls.filter((_, i) => i !== index))}
                      className="border border-rule px-2 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
                      aria-label={`Remove link ${index + 1}`}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                {problem ? (
                  <p className="mt-1 text-xs text-flag">{problem.message}</p>
                ) : null}
              </div>
            );
          })}
        </div>
        {urls.length < MAX_URLS ? (
          <button
            type="button"
            onClick={() => setUrls([...urls, ""])}
            className="mt-2 border border-rule px-2.5 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
          >
            Add another link
          </button>
        ) : (
          <p className="mt-2 text-xs text-ink-faint">
            That is the maximum the contract accepts.
          </p>
        )}
      </fieldset>

      {statementTooLong ? (
        <p className="mt-4 text-sm text-flag">
          Your statement is over the contract&rsquo;s {MAX_STATEMENT_CHARS.toLocaleString()}
          -character limit.
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {!address ? (
          <button
            type="button"
            onClick={connect}
            className="border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent-wash"
          >
            Connect to file
          </button>
        ) : (
          <button
            type="button"
            disabled={blocked || status === "signing" || status === "waiting"}
            onClick={() => {
              reset();
              setConfirming(true);
            }}
            className="border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent-wash disabled:cursor-not-allowed disabled:border-rule disabled:text-ink-faint"
          >
            {status === "signing"
              ? "Waiting for signature…"
              : status === "waiting"
                ? "Submitting…"
                : "Review and file"}
          </button>
        )}
        {empty ? (
          <span className="text-xs text-ink-faint">
            Write a statement or add a link before filing.
          </span>
        ) : null}
      </div>

      {status === "waiting" ? (
        // Filing is an ordinary state transition, so `nondet` is false: the
        // contract does no fetching or model work until the case is judged.
        <ConsensusProgress snapshot={consensus} nondet={false} />
      ) : null}

      {status === "failed" && error ? (
        <p
          className="mt-3 border border-flag bg-flag-wash px-3 py-2 text-sm text-ink"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {status === "done" ? (
        <p className="mt-3 text-sm text-accent" role="status">
          Filed. It appears in the record above.
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title="File this statement"
        consequence="Your statement and links are stored on chain permanently and publicly. The other party can read them. You cannot edit, withdraw or delete this filing, and you may not file again on this case."
        confirmLabel="File it"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setConfirming(false);
          await submit({
            action: "submit_evidence",
            caseId: record.caseId,
            value: 0n,
            statement,
            urls: filled,
          });
          setStatement("");
          setUrls([""]);
        }}
        extra={
          <div className="mt-4 border border-rule bg-leaf px-3 py-2">
            <p className="text-xs text-ink-faint">You are filing</p>
            <p className="mt-1 text-sm text-ink">
              {statement.trim() === ""
                ? "No statement"
                : `${statement.trim().length.toLocaleString()} characters`}
              {filled.length > 0
                ? `, and ${filled.length} ${filled.length === 1 ? "link" : "links"}`
                : ", and no links"}
              .
            </p>
          </div>
        }
      />
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <section className="border border-rule p-5">{children}</section>;
}

/** The contract's URL rules, applied before a signature rather than after. */
function validateUrls(urls: readonly string[]): UrlProblem[] {
  const problems: UrlProblem[] = [];
  urls.forEach((raw, index) => {
    const url = raw.trim();
    if (url === "") return;
    if (url.length > MAX_URL_CHARS) {
      problems.push({
        index,
        message: `Over the contract's ${MAX_URL_CHARS}-character limit for a link.`,
      });
      return;
    }
    if (!url.startsWith("https://")) {
      problems.push({ index, message: "The contract accepts https:// links only." });
      return;
    }
    if (/\s/.test(url)) {
      problems.push({ index, message: "A link cannot contain spaces." });
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.host === "") {
        problems.push({ index, message: "That is not a complete https address." });
      }
    } catch {
      problems.push({ index, message: "That is not a valid web address." });
    }
  });
  return problems;
}
