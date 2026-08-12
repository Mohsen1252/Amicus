"use client";

/**
 * Proposing an agreement: the one screen where a case begins.
 *
 * Two things make this different from every other action in the app.
 *
 * The first is cost. Every other action either sends nothing or sends a bond
 * against a case that already exists. This one sends the full amount at stake
 * plus a bond into a contract that will not give it back on request - once the
 * respondent accepts, the money moves by cooperative release or by a panel, and
 * by nothing else. So the totals are stated before the signature, exactly, and
 * the confirmation says what cannot be undone.
 *
 * The second is that the agreement text is the thing that will be judged. It is
 * not a description of the deal; it is the deal, read by a model that will be
 * given no other account of what was meant. The form says so rather than
 * presenting a nondescript "description" box.
 */

import Link from "next/link";
import { useState } from "react";

import { formatBps, parseAmountToAtto } from "@/lib/atto";
import { proposalValue } from "@/lib/contract";
import {
  DRAFT_EXPIRY_SEC,
  EVIDENCE_WINDOWS,
  MAX_AGREEMENT_CHARS,
  checkProposal,
  windowLabel,
  type ProposalDraft,
} from "@/lib/proposal";
import { useStats } from "@/lib/queries";
import { formatDuration } from "@/lib/time";
import { useSubmitProposal } from "@/lib/use-submit-proposal";
import { ConfirmDialog } from "./confirm-dialog";
import { Amount, ExactAmount } from "./primitives";
import { useWallet } from "./wallet";

const EMPTY: ProposalDraft = {
  respondent: "",
  agreementText: "",
  amountInput: "",
  bondInput: "",
  // 7 days: long enough to gather a record, short enough that a dispute does
  // not sit open for a month by default.
  evidenceWindowSec: 604_800n,
};

export function ProposeForm() {
  const { address, connect, connecting } = useWallet();
  const stats = useStats();
  const { submit, status, error, caseId, reset } = useSubmitProposal();
  const [draft, setDraft] = useState<ProposalDraft>(EMPTY);
  const [confirming, setConfirming] = useState(false);

  const check = checkProposal(draft, address);
  const total = check.ok ? proposalValue(check.request) : null;
  const busy = status === "signing" || status === "waiting";

  function set<K extends keyof ProposalDraft>(key: K, value: ProposalDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  if (status === "done") {
    return (
      <Proposed
        caseId={caseId}
        onAgain={() => {
          reset();
          setDraft(EMPTY);
        }}
      />
    );
  }

  return (
    <section className="py-8">
      <h1 className="font-serif text-2xl text-ink">Propose an agreement</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        You are the claimant. You write the agreement, name the other party, and deposit
        the amount at stake plus your bond. The case opens once they match your bond.
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-8">
          <Field
            label="The other party"
            hint="The respondent's address. Only this address can accept, and the contract will not let it be you."
            problem={check.problems.respondent}
          >
            <input
              type="text"
              value={draft.respondent}
              onChange={(event) => set("respondent", event.target.value)}
              placeholder="0x"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={check.problems.respondent !== undefined}
              className="w-full border border-rule bg-leaf px-3 py-2 font-mono text-[0.8125rem] text-ink"
            />
          </Field>

          <Field
            label="The agreement"
            hint="Plain language. This exact text is what a panel reads if the case is ever disputed - it will have nothing else describing what was promised."
            problem={check.problems.agreementText}
            counter={`${draft.agreementText.length.toLocaleString()} / ${MAX_AGREEMENT_CHARS.toLocaleString()}`}
            counterWarn={draft.agreementText.length > MAX_AGREEMENT_CHARS * 0.9}
          >
            <textarea
              value={draft.agreementText}
              onChange={(event) => set("agreementText", event.target.value)}
              rows={8}
              maxLength={MAX_AGREEMENT_CHARS}
              placeholder="Deliver the redesign by 4 March, in the format agreed in the brief."
              aria-invalid={check.problems.agreementText !== undefined}
              className="w-full border border-rule bg-leaf px-3 py-2 font-serif text-[0.9375rem] text-ink"
            />
          </Field>

          <div className="grid gap-6 sm:grid-cols-2">
            <Field
              label="Amount at stake"
              hint="What the respondent is owed if the agreement is kept. You deposit it now."
              problem={check.problems.amount}
            >
              <AmountInput
                value={draft.amountInput}
                onChange={(value) => set("amountInput", value)}
                invalid={check.problems.amount !== undefined}
                label="Amount at stake"
              />
            </Field>

            <Field
              label="Bond from each side"
              hint="Posted by both parties. On a decisive judgment the loser's bond goes to the winner; otherwise both come home."
              problem={check.problems.bond}
            >
              <AmountInput
                value={draft.bondInput}
                onChange={(value) => set("bondInput", value)}
                invalid={check.problems.bond !== undefined}
                label="Bond from each side"
              />
            </Field>
          </div>

          <Field
            label="Filing window"
            hint="If a dispute is ever opened, this is how long both sides have to file a statement and evidence. It is fixed now and cannot be changed or extended later."
          >
            <select
              value={String(draft.evidenceWindowSec)}
              onChange={(event) => set("evidenceWindowSec", BigInt(event.target.value))}
              className="w-full border border-rule bg-leaf px-3 py-2 text-sm text-ink sm:w-56"
            >
              {EVIDENCE_WINDOWS.map((option) => (
                <option key={String(option.seconds)} value={String(option.seconds)}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="border border-rule">
            <h2 className="stamp border-b border-rule bg-leaf px-3 py-1.5 text-ink-muted">
              What you are depositing
            </h2>
            <div className="px-3 py-3">
              <Line label="Amount at stake" input={draft.amountInput} />
              <Line label="Your bond" input={draft.bondInput} />
              <div className="mt-2 border-t border-rule pt-2">
                <p className="text-xs text-ink-faint">Leaving your wallet</p>
                {total === null ? (
                  <p className="mt-0.5 text-sm text-ink-faint">
                    Fill in both amounts to see the total.
                  </p>
                ) : (
                  <>
                    <p className="mt-0.5">
                      <Amount atto={total} className="text-base text-ink" />
                    </p>
                    <ExactAmount atto={total} />
                  </>
                )}
              </div>
              <p className="mt-3 text-xs text-ink-faint">
                The contract requires this exact figure - it rejects an overpayment rather
                than refunding it.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-2 text-xs text-ink-faint">
            <p>
              The respondent has {formatDuration(DRAFT_EXPIRY_SEC)} to accept and match
              your bond. If they do not, the draft expires and anyone can return your
              deposit to you in full.
            </p>
            {stats.data ? (
              <p>
                A fee of {formatBps(stats.data.feeBps)} is charged only if a panel decides
                the case. Settling cooperatively costs nothing.
              </p>
            ) : null}
          </div>
        </aside>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-rule pt-6">
        {!address ? (
          <button
            type="button"
            onClick={connect}
            disabled={connecting}
            className="border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent-wash disabled:opacity-60"
          >
            {connecting ? "Connecting…" : "Connect to propose"}
          </button>
        ) : (
          <button
            type="button"
            disabled={!check.ok || busy}
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
                : "Review and propose"}
          </button>
        )}
        {address && !check.ok ? (
          <span className="text-xs text-ink-faint">
            Every field above is required before this can be submitted.
          </span>
        ) : null}
      </div>

      {status === "failed" && error ? (
        <p
          className="mt-4 border border-flag bg-flag-wash px-3 py-2 text-sm text-ink"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {check.ok ? (
        <ConfirmDialog
          open={confirming}
          title="Propose this agreement"
          consequence={
            "This deposits the amount at stake and your bond into the contract now. You " +
            "cannot withdraw them on request: once the respondent accepts, the funds move " +
            "only by cooperative release or by a panel's decision. The agreement text is " +
            "stored on chain permanently and publicly, and cannot be edited afterwards."
          }
          confirmLabel="Propose and deposit"
          value={proposalValue(check.request)}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            await submit(check.request);
          }}
          extra={
            <div className="mt-4 border border-rule bg-leaf px-3 py-2 text-sm">
              <dl className="space-y-1">
                <Row label="Respondent">
                  <span className="font-mono text-xs break-all">
                    {check.request.respondent}
                  </span>
                </Row>
                <Row label="Amount at stake">
                  <Amount atto={check.request.attoAmount} className="text-ink" />
                </Row>
                <Row label="Bond from each side">
                  <Amount atto={check.request.bondAtto} className="text-ink" />
                </Row>
                <Row label="Filing window">
                  {windowLabel(check.request.evidenceWindowSec)}
                </Row>
              </dl>
            </div>
          }
        />
      ) : null}
    </section>
  );
}

function Proposed({ caseId, onAgain }: { caseId: string | null; onAgain: () => void }) {
  return (
    <section className="py-8">
      <p className="stamp text-accent">Proposed</p>
      <h1 className="mt-2 font-serif text-2xl text-ink">The case is on the register.</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        Your deposit is held by the contract. The respondent must accept and match your
        bond before the agreement takes effect; until then the case sits in draft.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {caseId ? (
          <Link
            href={`/cases/${encodeURIComponent(caseId)}`}
            className="border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent-wash"
          >
            Open {caseId}
          </Link>
        ) : (
          <Link
            href="/"
            className="border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent-wash"
          >
            Go to the docket
          </Link>
        )}
        <button
          type="button"
          onClick={onAgain}
          className="border border-rule px-3 py-1.5 text-sm text-ink-muted hover:border-rule-strong hover:text-ink"
        >
          Propose another
        </button>
      </div>
      {caseId ? null : (
        <p className="mt-4 max-w-2xl text-xs text-ink-faint">
          The proposal was accepted, but this interface could not confirm which entry on
          the register is yours - another proposal may have landed at the same moment. The
          docket has it.
        </p>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  problem,
  counter,
  counterWarn,
  children,
}: {
  label: string;
  hint: string;
  problem?: string;
  counter?: string;
  counterWarn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm text-ink">{label}</span>
      <span className="mt-0.5 block text-xs text-ink-faint">{hint}</span>
      <span className="mt-2 block">{children}</span>
      <span className="mt-1 flex justify-between gap-4 text-xs">
        <span className="text-flag" role={problem ? "alert" : undefined}>
          {problem ?? ""}
        </span>
        {counter ? (
          <span className={counterWarn ? "text-flag" : "text-ink-faint"}>{counter}</span>
        ) : null}
      </span>
    </label>
  );
}

/**
 * A decimal amount.
 *
 * Held as the string the user typed and converted to atto only by
 * `parseAmountToAtto`, so no amount in this form is ever a `Number`.
 */
function AmountInput({
  value,
  onChange,
  invalid,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  label: string;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="0.0"
      spellCheck={false}
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid}
      className="w-full border border-rule bg-leaf px-3 py-2 font-mono text-[0.8125rem] text-ink tabular-nums"
    />
  );
}

/** One line of the deposit summary, live as the amount is typed. */
function Line({ label, input }: { label: string; input: string }) {
  const parsed = parseAmountToAtto(input);
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <span className="text-xs text-ink-faint">{label}</span>
      {parsed.ok ? (
        <Amount atto={parsed.atto} className="text-sm text-ink" />
      ) : (
        <span className="text-sm text-ink-faint">-</span>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="text-right text-sm text-ink">{children}</dd>
    </div>
  );
}
