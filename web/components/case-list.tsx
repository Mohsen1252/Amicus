"use client";

/**
 * The docket: every case, its state, what is at stake, and any clock running.
 *
 * A case needing the viewer's attention is marked in the left gutter, because a
 * missed evidence deadline costs real money and a row that looks like every
 * other row is how that happens.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { MAX_PAGE_LIMIT } from "@/lib/contract";
import { useCasePage, useStats } from "@/lib/queries";
import { chainNowSec, deadlineStatus } from "@/lib/time";
import type { CaseRecord } from "@/lib/types";
import { useWallet } from "./wallet";
import { Amount, Countdown, StateBadge } from "./primitives";
import { LoadingRows, ReadError } from "./states";
import { attentionFor, viewerRoleFor } from "@/lib/roles";

const PAGE_SIZE = 20;

export function CaseList() {
  const [offset, setOffset] = useState(0);
  const [minePeriod, setMineOnly] = useState(false);
  const { address } = useWallet();
  const stats = useStats();
  const page = useCasePage(offset, PAGE_SIZE);

  const rows = useMemo(() => {
    const all = page.data ?? [];
    if (!minePeriod || !address) return all;
    const mine = address.toLowerCase();
    return all.filter(
      (item) =>
        item.claimant.toLowerCase() === mine || item.respondent.toLowerCase() === mine,
    );
  }, [page.data, minePeriod, address]);

  const total = stats.data ? Number(stats.data.totalCases) : null;
  const hasMore = total !== null && offset + PAGE_SIZE < total;

  return (
    <section className="py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl text-ink">Docket</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {total === null
              ? "Reading the register…"
              : `${total} ${total === 1 ? "case" : "cases"} registered.`}
          </p>
        </div>
        <div className="flex items-center gap-1 border border-rule p-0.5" role="group" aria-label="Filter cases">
          <FilterButton active={!minePeriod} onClick={() => setMineOnly(false)}>
            All cases
          </FilterButton>
          <FilterButton
            active={minePeriod}
            onClick={() => setMineOnly(true)}
            disabled={!address}
            title={address ? undefined : "Connect a wallet to filter to your cases"}
          >
            Cases I am party to
          </FilterButton>
        </div>
      </div>

      <div className="mt-6">
        {page.error ? (
          <ReadError error={page.error} onRetry={() => page.mutate()} />
        ) : page.isLoading && !page.data ? (
          <LoadingRows rows={4} />
        ) : rows.length === 0 ? (
          <EmptyDocket filtered={minePeriod} hasAny={(total ?? 0) > 0} />
        ) : (
          <ul className="border-t border-rule">
            {rows.map((item) => (
              <CaseRow key={item.caseId} record={item} viewer={address ?? null} />
            ))}
          </ul>
        )}
      </div>

      {total !== null && total > PAGE_SIZE ? (
        <nav className="mt-6 flex items-center justify-between" aria-label="Docket pages">
          <button
            type="button"
            className="border border-rule px-3 py-1.5 text-sm text-ink-muted disabled:opacity-40"
            disabled={offset === 0}
            onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
          >
            Previous
          </button>
          <span className="font-mono text-xs text-ink-faint">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button
            type="button"
            className="border border-rule px-3 py-1.5 text-sm text-ink-muted disabled:opacity-40"
            disabled={!hasMore}
            onClick={() => setOffset((value) => value + PAGE_SIZE)}
          >
            Next
          </button>
        </nav>
      ) : null}

      <p className="mt-4 text-xs text-ink-faint">
        Pages are read through the contract&rsquo;s own pagination, {MAX_PAGE_LIMIT} rows
        at most per read.
      </p>
    </section>
  );
}

function FilterButton({
  active,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`px-3 py-1.5 text-sm disabled:opacity-40 ${
        active ? "bg-accent-wash text-accent" : "text-ink-muted hover:text-ink"
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}

function CaseRow({ record, viewer }: { record: CaseRecord; viewer: string | null }) {
  const role = viewerRoleFor(record, viewer);
  const now = chainNowSec();
  const attention = attentionFor(record, role, now);
  const counterparty =
    role === "claimant"
      ? record.respondent
      : role === "respondent"
        ? record.claimant
        : record.respondent;

  return (
    <li className="border-b border-rule">
      <Link
        href={`/cases/${encodeURIComponent(record.caseId)}`}
        className="grid grid-cols-1 gap-x-6 gap-y-2 py-4 sm:grid-cols-12 sm:items-baseline"
      >
        {/* The attention gutter: the one place a row can shout. */}
        <span className="sm:col-span-3 flex items-baseline gap-3">
          <span className="font-mono text-sm text-ink">{record.caseId}</span>
          <StateBadge state={record.state} />
        </span>

        <span className="sm:col-span-3 text-sm text-ink-muted">
          <span className="text-ink-faint">
            {role === "observer" ? "respondent " : "counterparty "}
          </span>
          <span className="font-mono text-[0.8125rem] text-ink">
            {counterparty.slice(0, 8)}…{counterparty.slice(-6)}
          </span>
        </span>

        <span className="sm:col-span-2 text-sm">
          <Amount atto={record.attoAmount} className="text-ink" />
          <span className="ml-1 text-xs text-ink-faint">at stake</span>
        </span>

        <span className="sm:col-span-2 text-sm text-ink-muted">
          <DeadlineCell record={record} now={now} />
        </span>

        <span className="sm:col-span-2 sm:text-right">
          {attention ? (
            <span className="stamp border border-flag px-1.5 py-0.5 text-flag">
              {attention}
            </span>
          ) : role !== "observer" ? (
            <span className="stamp text-stamp">you are the {role}</span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function DeadlineCell({ record, now }: { record: CaseRecord; now: bigint }) {
  if (!record.state.known) return <span className="text-ink-faint">-</span>;
  const state = record.state.value;

  if (state === "DRAFT") {
    return (
      <>
        <span className="text-ink-faint">acceptance </span>
        <Countdown status={deadlineStatus(record.acceptDeadline, now)} />
      </>
    );
  }
  if (state === "DISPUTED" || state === "EVIDENCE") {
    return (
      <>
        <span className="text-ink-faint">filings </span>
        <Countdown status={deadlineStatus(record.evidenceDeadline, now)} />
      </>
    );
  }
  if (state === "JUDGED") {
    return (
      <>
        <span className="text-ink-faint">appeal </span>
        <Countdown status={deadlineStatus(record.appealDeadline, now)} />
      </>
    );
  }
  return <span className="text-ink-faint">-</span>;
}

function EmptyDocket({ filtered, hasAny }: { filtered: boolean; hasAny: boolean }) {
  if (filtered) {
    return (
      <div className="border border-rule bg-leaf p-8">
        <p className="text-sm text-ink">
          {hasAny
            ? "None of the registered cases list your address as a party."
            : "No cases are registered yet."}
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          Switch to all cases to read the full docket.
        </p>
      </div>
    );
  }
  return (
    <div className="border border-rule bg-leaf p-8">
      <p className="text-sm text-ink">No cases are registered on this contract yet.</p>
      <p className="mt-1 text-sm text-ink-muted">
        A case appears here once a claimant proposes one and funds it.
      </p>
      <Link
        href="/propose"
        className="mt-4 inline-block border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent-wash"
      >
        Propose a case
      </Link>
    </div>
  );
}
