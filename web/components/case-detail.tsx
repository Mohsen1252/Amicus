"use client";

/**
 * The case file.
 *
 * Laid out as the record in the order it happened - the agreement, the bonds,
 * the dispute, each filing, the judgment, the appeal, the payout - down a docket
 * rule, each entry stamped with the chain time it was recorded. It is a record,
 * not a conversation, so nothing is styled as a message and nothing is grouped
 * by speaker.
 *
 * The facts panel beside it carries only what the contract holds: the parties,
 * the amounts, the fee rate, the deadlines. It contains no estimate of what
 * anyone will receive.
 */

import Link from "next/link";

import { describeReadError, type SectionRead } from "@/lib/contract";
import { useCaseBundle } from "@/lib/queries";
import { chainNowSec, deadlineStatus, formatTimestamp } from "@/lib/time";
import { formatBps } from "@/lib/atto";
import { losingSideFor, viewerRoleFor } from "@/lib/roles";
import {
  OUTCOME_DESCRIPTIONS,
  STATE_DESCRIPTIONS,
  type CaseRecord,
  type EvidenceRecord,
  type JudgmentRecord,
  type PayoutRecord,
} from "@/lib/types";
import { ActionPanel } from "./actions";
import { EvidenceForm } from "./evidence-form";
import { JudgmentEntry } from "./judgment";
import {
  AddressText,
  Amount,
  Countdown,
  ExactAmount,
  Fact,
  StateBadge,
  Timestamp,
} from "./primitives";
import { ErrorPanel, LoadingBlock } from "./states";
import { AgreementText, PartyFiling, UrlText } from "./untrusted-text";
import { useWallet } from "./wallet";

export function CaseDetail({ caseId }: { caseId: string }) {
  const { data, error, isLoading, mutate } = useCaseBundle(caseId);
  const { address } = useWallet();

  if (error) {
    // The contract's own reason, dug out of the receipt. Testing the thrown
    // message directly does not work: genlayer-js replaces it with a generic
    // viem sentence about invalid parameters. See describeReadError.
    const failure = describeReadError(error);
    return (
      <div className="py-8">
        <BackLink />
        <div className="mt-6">
          <ErrorPanel
            title={
              failure.missing
                ? `No case with the id "${caseId}" exists on this contract.`
                : failure.message
            }
            detail={failure.detail ?? undefined}
            onRetry={failure.retryable ? () => mutate() : undefined}
          />
        </div>
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="py-8">
        <BackLink />
        <LoadingBlock />
      </div>
    );
  }

  if (!data) return null;

  const { record, evidence, judgments, payout, isJudgeable } = data;
  const role = viewerRoleFor(record, address ?? null);
  const now = chainNowSec();

  // When the filings could not be read, whether this viewer has already filed
  // is unknown. It is treated as not-filed so the action is still offered:
  // availability in this app is advisory, the contract checks again, and it
  // rejects a second filing with its own clear reason. Hiding the control on a
  // failed read would be the interface inventing a rule.
  const filings = evidence.ok ? evidence.value : [];
  const hasFiled = filings.some((entry) => entry.role === role);

  return (
    <div className="py-8">
      <BackLink />

      <header className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-xl text-ink">{record.caseId}</h1>
            <StateBadge state={record.state} />
          </div>
          <p className="mt-2 max-w-xl text-sm text-ink-muted">
            {record.state.known
              ? STATE_DESCRIPTIONS[record.state.value]
              : "This contract reported a state this interface does not recognise. Read the case with care."}
          </p>
        </div>
        {role !== "observer" ? (
          <span className="stamp border border-accent px-2 py-1 text-accent">
            You are the {role}
          </span>
        ) : null}
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <Record
            record={record}
            evidence={evidence}
            judgments={judgments}
            payout={payout}
          />
        </div>

        <aside className="space-y-8 lg:sticky lg:top-6 lg:self-start">
          <FactsPanel record={record} now={now} />
          <ActionPanel
            record={record}
            role={role}
            isJudgeable={isJudgeable}
            hasFiled={hasFiled}
          />
        </aside>
      </div>

      {record.state.known &&
      (record.state.value === "DISPUTED" || record.state.value === "EVIDENCE") ? (
        <div className="mt-12">
          <EvidenceForm
            record={record}
            role={role}
            hasFiled={hasFiled}
          />
        </div>
      ) : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/" className="text-sm text-accent hover:underline">
      ← Docket
    </Link>
  );
}

/** One entry in the record, pinned to the docket rule with its stamp. */
function Entry({
  stamp,
  timestamp,
  title,
  children,
}: {
  stamp: string;
  timestamp?: bigint;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="relative border-l border-rule pb-8 pl-6 last:pb-0">
      <span
        aria-hidden
        className="absolute -left-[3px] top-1.5 h-1.5 w-1.5 rounded-full bg-rule-strong"
      />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="stamp text-stamp">{stamp}</span>
        {timestamp !== undefined && timestamp > 0n ? (
          <Timestamp seconds={timestamp} />
        ) : null}
      </div>
      {title ? <p className="mt-1 text-sm text-ink">{title}</p> : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </li>
  );
}

function Record({
  record,
  evidence,
  judgments,
  payout,
}: {
  record: CaseRecord;
  evidence: SectionRead<readonly EvidenceRecord[]>;
  judgments: SectionRead<readonly JudgmentRecord[]>;
  payout: PayoutRecord | null;
}) {
  const filings = evidence.ok ? evidence.value : [];
  const rulings = judgments.ok ? judgments.value : [];
  const state = record.state.known ? record.state.value : null;
  const disputeOpened =
    record.evidenceDeadline > 0n
      ? record.evidenceDeadline - record.evidenceWindowSec
      : 0n;

  return (
    <section aria-label="Case record">
      <h2 className="stamp mb-4 text-stamp">The record</h2>
      <ol className="list-none">
        <Entry
          stamp="Agreement registered"
          timestamp={record.createdAt}
          title="The claimant proposed this agreement and deposited the amount at stake plus a bond."
        >
          <AgreementText text={record.agreementText} />
        </Entry>

        {record.respondentBonded ? (
          <Entry
            stamp="Respondent bonded"
            title="The respondent posted a matching bond, putting the agreement into effect."
          />
        ) : state === "DRAFT" ? (
          <Entry
            stamp="Awaiting respondent"
            timestamp={record.acceptDeadline}
            title="The respondent has not yet posted a bond. If the acceptance deadline passes, the claimant's deposit is returned."
          />
        ) : null}

        {state === "EXPIRED" || (state === "PAID" && !record.respondentBonded) ? (
          <Entry
            stamp="Draft expired"
            title="The respondent never accepted, so the claimant's deposit was returned."
          />
        ) : null}

        {state === "RELEASED" || (payout && !record.outcome && record.respondentBonded) ? (
          <Entry
            stamp="Released cooperatively"
            title="A party released the funds without a dispute. No fee was charged."
          />
        ) : null}

        {record.evidenceDeadline > 0n ? (
          <Entry
            stamp="Dispute opened"
            timestamp={disputeOpened}
            title={`A party opened a dispute. Filings closed at ${formatTimestamp(record.evidenceDeadline)}.`}
          />
        ) : null}

        {!evidence.ok ? (
          <Entry stamp="Filings unavailable" title={evidence.reason}>
            <p className="text-xs text-ink-faint">
              The rest of this record was read successfully. Only the filings could not
              be, so this section is missing rather than empty.
            </p>
          </Entry>
        ) : null}

        {filings.length > 0
          ? filings.map((entry) => (
              <Entry
                key={`${entry.role}-${entry.timestamp}`}
                stamp={`Statement filed`}
                timestamp={entry.timestamp}
              >
                <div className="space-y-4">
                  <PartyFiling
                    role={entry.role}
                    submitter={entry.submitter}
                    statement={entry.statement}
                    timestamp={entry.timestamp}
                    tampered={entry.tampered}
                  />
                  {entry.urls.length > 0 ? (
                    <CitedUrls urls={entry.urls} />
                  ) : (
                    <p className="text-xs text-ink-faint">No links were cited.</p>
                  )}
                </div>
              </Entry>
            ))
          : evidence.ok && record.evidenceDeadline > 0n
            ? <Entry
                stamp="No statements filed"
                title="Neither party filed before the deadline. The panel was told the record was empty."
              />
            : null}

        {!judgments.ok ? (
          <Entry stamp="Judgments unavailable" title={judgments.reason} />
        ) : null}

        {rulings.map((judgment, index) => (
          <Entry
            key={`${judgment.stage}-${judgment.timestamp}-${index}`}
            stamp={judgment.stage === "appeal" ? "Appeal decided" : "Panel ruled"}
            timestamp={judgment.timestamp}
          >
            <JudgmentEntry judgment={judgment} />
          </Entry>
        ))}

        {record.appellant ? (
          <Entry
            stamp="Appeal filed"
            title={`The ${record.appellant} posted an escalation bond and asked for a rehearing. One level of appeal is permitted, and it has been used.`}
          />
        ) : null}

        {payout ? (
          <Entry stamp="Distribution executed" timestamp={payout.timestamp}>
            <PayoutTable payout={payout} record={record} />
          </Entry>
        ) : null}
      </ol>
    </section>
  );
}

function CitedUrls({ urls }: { urls: readonly string[] }) {
  return (
    <div>
      <p className="stamp text-stamp">Links cited</p>
      <ul className="mt-1.5 space-y-1">
        {urls.map((url) => (
          <li key={url} className="text-[0.8125rem]">
            <UrlText url={url} />
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-ink-faint">
        Submitted by a party. This page does not open or preview them; the fetch result
        recorded by the contract appears with the judgment.
      </p>
    </div>
  );
}

/**
 * What the contract actually distributed.
 *
 * These are figures the contract recorded, not a calculation this app performed.
 */
function PayoutTable({
  payout,
  record,
}: {
  payout: PayoutRecord;
  record: CaseRecord;
}) {
  const rows = [
    { label: "Claimant", address: record.claimant, atto: payout.claimantAtto },
    { label: "Respondent", address: record.respondent, atto: payout.respondentAtto },
    { label: "Fee", address: null, atto: payout.ownerAtto },
  ];
  return (
    <div className="border border-rule">
      <p className="stamp border-b border-rule bg-leaf px-3 py-1.5 text-ink-muted">
        As recorded by the contract
      </p>
      <table className="w-full text-sm">
        <caption className="sr-only">Amounts distributed when the case settled</caption>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-rule last:border-0">
              <th scope="row" className="px-3 py-2 text-left font-normal text-ink-muted">
                {row.label}
                {row.address ? (
                  <span className="ml-2">
                    <AddressText address={row.address} />
                  </span>
                ) : null}
              </th>
              <td className="px-3 py-2 text-right">
                <Amount atto={row.atto} className="text-ink" />
                <ExactAmount atto={row.atto} />
              </td>
            </tr>
          ))}
          <tr className="bg-leaf">
            <th scope="row" className="px-3 py-2 text-left font-normal text-ink">
              Total held
            </th>
            <td className="px-3 py-2 text-right">
              <Amount atto={payout.escrowAtto} className="text-ink" />
              <ExactAmount atto={payout.escrowAtto} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="border-t border-rule px-3 py-2 text-xs text-ink-faint">
        Transfers settle when the transaction finalizes, not when it is accepted, so
        balances may lag this record briefly.
      </p>
    </div>
  );
}

function FactsPanel({ record, now }: { record: CaseRecord; now: bigint }) {
  const state = record.state.known ? record.state.value : null;
  const losing = losingSideFor(record);

  return (
    <section aria-label="Case facts" className="border border-rule">
      <h2 className="stamp border-b border-rule bg-leaf px-3 py-1.5 text-ink-muted">
        Facts on chain
      </h2>
      <dl className="divide-y divide-rule px-3">
        <Fact label="Claimant">
          <AddressText address={record.claimant} />
        </Fact>
        <Fact label="Respondent">
          <AddressText address={record.respondent} />
        </Fact>
        <Fact label="Amount at stake">
          <Amount atto={record.attoAmount} className="text-ink" />
          <ExactAmount atto={record.attoAmount} />
        </Fact>
        <Fact
          label="Bond, each side"
          hint={
            record.respondentBonded
              ? "Both bonds are held by the contract."
              : "Only the claimant has bonded so far."
          }
        >
          <Amount atto={record.bondAtto} className="text-ink" />
          <ExactAmount atto={record.bondAtto} />
        </Fact>
        {record.appealBondAtto > 0n ? (
          <Fact label="Escalation bond" hint={`Posted by the ${record.appellant}.`}>
            <Amount atto={record.appealBondAtto} className="text-ink" />
            <ExactAmount atto={record.appealBondAtto} />
          </Fact>
        ) : null}
        <Fact
          label="Fee rate"
          hint="Set when the contract was deployed and fixed for this case. Charged only on a judged outcome."
        >
          <span className="font-mono">{formatBps(record.feeBps)}</span>
        </Fact>
        {record.evidenceDeadline > 0n ? (
          <Fact label="Filings close" hint={formatTimestamp(record.evidenceDeadline)}>
            <Countdown status={deadlineStatus(record.evidenceDeadline, now)} />
          </Fact>
        ) : null}
        {state === "DRAFT" ? (
          <Fact label="Acceptance closes" hint={formatTimestamp(record.acceptDeadline)}>
            <Countdown status={deadlineStatus(record.acceptDeadline, now)} />
          </Fact>
        ) : null}
        {state === "JUDGED" ? (
          <Fact
            label="Appeal closes"
            hint={
              losing
                ? `Only the ${losing} may appeal this outcome.`
                : "Neither side prevailed outright, so either may appeal."
            }
          >
            <Countdown status={deadlineStatus(record.appealDeadline, now)} />
          </Fact>
        ) : null}
        {record.outcome ? (
          <Fact
            label="Outcome"
            hint={
              record.outcome.known
                ? OUTCOME_DESCRIPTIONS[record.outcome.value]
                : undefined
            }
          >
            {record.outcome.known ? (
              <span className="text-ink">
                {record.outcome.value === "SPLIT"
                  ? `Split, ${formatBps(record.splitBps)} to the claimant`
                  : OUTCOME_DESCRIPTIONS[record.outcome.value].split(".")[0]}
              </span>
            ) : (
              <span className="text-flag">
                Unrecognised outcome: {record.outcome.raw}
              </span>
            )}
          </Fact>
        ) : null}
      </dl>
    </section>
  );
}
