"use client";

/**
 * How Amicus works, for someone about to put money into it.
 *
 * Written in the same register as the rest of the app: this explains a
 * mechanism that will hold someone's funds and decide who gets them, so it
 * states what the contract does and what it does not, including where it can
 * refuse to decide. It does not sell anything.
 *
 * Every number here comes from lib/protocol.ts, which mirrors the contract's
 * own constants, so the documentation cannot quietly drift from the rules it
 * describes.
 */

import Link from "next/link";
import { useState } from "react";

import {
  LIFECYCLE,
  OUTCOME_RULES,
  PARAMETER_GROUPS,
  SPLIT_TOLERANCE_BPS,
} from "@/lib/protocol";
import { NETWORK_LABELS, configResult, isConfigError } from "@/lib/config";

export function ProtocolDocs() {
  return (
    <div className="mx-auto max-w-2xl py-8">
      <header>
        <h1 className="font-serif text-2xl tracking-tight text-ink">How Amicus works</h1>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-muted">
          Amicus is an escrow that settles agreements written in plain language. Two parties
          register what they agreed in ordinary prose and each posts a bond. If the deal goes
          well, either side releases the funds. If it does not, the contract reads the
          agreement, fetches the evidence both sides cite, and decides.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-muted">
          There is no arbitrator to appoint, no template to fit the agreement into, and no
          off-chain service holding the money. The judgment happens inside the contract.
        </p>
      </header>

      <Section title="What makes this possible">
        <p>
          An ordinary smart contract cannot read a sentence like &ldquo;the site must stay up
          through the launch weekend&rdquo; and decide whether it happened. It has no way to
          fetch a page and no way to weigh prose. GenLayer contracts can do both, because a
          contract can run{" "}
          <Term>non-deterministic operations</Term> &mdash; web requests and language model
          calls &mdash; and still reach consensus about the result.
        </p>
        <p>
          That is the whole reason Amicus exists on GenLayer rather than anywhere else. The
          agreement stays in the words the parties actually used.
        </p>
      </Section>

      <ConsensusSection />

      <Section title="The life of a case">
        <p>
          A case moves through a fixed set of states. Every transition is checked against a
          single table in the contract, and every one is checked again on chain no matter what
          this interface offers.
        </p>
        <ol className="mt-6 border-t border-rule">
          {LIFECYCLE.map((step) => (
            <li
              key={step.state}
              className="grid gap-x-6 gap-y-1 border-b border-rule py-4 sm:grid-cols-[7rem_1fr]"
            >
              <div>
                <span className="stamp text-stamp">{step.state}</span>
              </div>
              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <h3 className="text-[0.9375rem] text-ink">{step.title}</h3>
                  <span className="text-xs text-ink-faint">{step.who}</span>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="What the panel can decide">
        <p>
          There are four possible outcomes, and one of them is a refusal to decide. That is
          deliberate.
        </p>
        <dl className="mt-5 space-y-4">
          {OUTCOME_RULES.map((rule) => (
            <div key={rule.outcome} className="border-l-2 border-rule pl-4">
              <dt className="text-[0.9375rem] text-ink">{rule.outcome}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-ink-muted">{rule.effect}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Evidence, and what it is worth">
        <p>
          When a case is judged the contract fetches each cited link itself. It does not take
          either party&rsquo;s word for what a page says, and it does not read a copy either
          party supplied.
        </p>
        <ul className="mt-4 space-y-3 text-sm leading-relaxed text-ink-muted">
          <Bullet label="Retrieved">
            The contract fetched the page and the panel read it.
          </Bullet>
          <Bullet label="Could not be retrieved">
            The link was dead, blocked, or timed out. It proves nothing. A party gains nothing
            by having cited it and loses nothing beyond the absence of that support &mdash; so
            citing a dead link is neither a tactic nor a trap.
          </Bullet>
          <Bullet label="Excluded for tampering">
            The page tried to instruct the panel rather than inform it. Its contents were
            withheld from the decision entirely and it supported no finding.
          </Bullet>
        </ul>
      </Section>

      <TamperingSection />

      <Section title="Parameters and rules">
        <p>
          These are the contract&rsquo;s own bounds. They are fixed in its code, not
          configurable per case except where noted.
        </p>
        {PARAMETER_GROUPS.map((group) => (
          <div key={group.title} className="mt-6">
            <h3 className="stamp text-stamp">{group.title}</h3>
            <dl className="mt-2 border-t border-rule">
              {group.rows.map((row) => (
                <div
                  key={row.name}
                  className="grid gap-x-6 gap-y-1 border-b border-rule py-3 sm:grid-cols-[11rem_1fr]"
                >
                  <dt className="text-sm text-ink">{row.name}</dt>
                  <dd>
                    <p className="font-mono text-[0.8125rem] text-ink">{row.value}</p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-faint">{row.note}</p>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </Section>

      <Section title="What this interface is">
        <p>
          This app reads the contract and submits transactions to it. It holds no keys, no
          database and no copy of the record. Everything shown here was read from the chain at
          the moment you loaded it.
        </p>
        <p>
          It also has no authority. Where it shows an action as unavailable, that is a reading
          of the contract&rsquo;s rules offered to save you a wasted transaction &mdash; the
          contract checks again regardless, and its answer is the one that counts.
        </p>
        <WhereItPoints />
      </Section>

      <p className="mt-12 border-t border-rule pt-6 text-sm text-ink-muted">
        <Link href="/propose" className="text-accent underline underline-offset-2">
          Propose a case
        </Link>{" "}
        or{" "}
        <Link href="/" className="text-accent underline underline-offset-2">
          read the docket
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * The consensus explanation, expandable.
 *
 * Collapsed by default because someone proposing a case does not need it, and
 * available in full because someone deciding whether to trust the outcome does.
 */
function ConsensusSection() {
  const [open, setOpen] = useState(false);

  return (
    <Section title="How the decision is reached">
      <p>
        A GenLayer transaction is not executed once. One validator is chosen as{" "}
        <Term>leader</Term> and runs the contract. Other validators then decide whether they
        agree, and the transaction is only accepted if enough of them do.
      </p>
      <p>
        For Amicus the important part is <em>how</em> the validators decide. They do not re-run
        the leader&rsquo;s work. Each one fetches the evidence again and reaches its own
        judgment under a <strong className="font-medium text-ink">different framing</strong> of
        the same question, then compares only the conclusion.
      </p>
      <p>
        The leader is asked to adjudicate: read the agreement, read each side&rsquo;s case,
        decide which the evidence supports. A validator is asked to re-derive from first
        principles instead &mdash; state what each document establishes on its own terms, state
        what the agreement requires, and only then ask which side those facts support.
      </p>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mt-4 border border-rule px-2.5 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
      >
        {open ? "Hide why that matters" : "Why does the framing differ?"}
      </button>

      {open ? (
        <div className="mt-4 border-l-2 border-accent bg-accent-wash/40 py-1 pl-4">
          <p>
            Because if validators simply re-ran the leader, they would receive the identical
            input &mdash; including any manipulation planted in it &mdash; agree with it, and
            consensus would ratify the attack. Agreement between two runs of the same
            instructions on the same poisoned text is not evidence of anything.
          </p>
          <p className="mt-3">
            Asking a second reader the same question a different way is what makes agreement
            mean something. Manipulation aimed at the adjudicating framing has to also survive
            a bottom-up rederivation that never asks who should win until the last step.
          </p>
          <p className="mt-3">
            The comparison is deliberately narrow. The outcome must match exactly. A split
            proportion must fall within {SPLIT_TOLERANCE_BPS / 100} percentage points, because
            two honest readings of the same prose routinely differ by that much while agreeing
            entirely on substance. Whether a filing attempted manipulation must match. The
            written reasoning is never compared at all &mdash; it is prose, and prose never
            matches.
          </p>
          <p className="mt-3">
            When the panel cannot agree, nothing is written. No outcome, no payout, no partial
            state. That is the mechanism working: a reading two independent framings could not
            confirm does not get to move money.
          </p>
        </div>
      ) : null}
    </Section>
  );
}

function TamperingSection() {
  return (
    <Section title="Adversarial input">
      <p>
        Everything a party writes or links to is treated as material to be weighed and never as
        instructions. Statements, the agreement itself, and every fetched page are wrapped in
        markers that the contract strips from the text first, so no submission can close its
        own block and start speaking as the prompt.
      </p>
      <p>
        A separate pass examines each span on its own, asking only one question: does this try
        to instruct the reader, impersonate system output, or claim authority over the decision?
        It is never asked to decide anything about the dispute, so a filing that captures it
        gains nothing.
      </p>
      <p>
        Ordinary argument, insistence, emotion, quoted correspondence and factual claims are not
        tampering. Only manipulation of the reader is. Where it is found, the record says so
        against whoever supplied it &mdash; arguing in bad faith is weighed against that party,
        and this interface marks it in a colour it uses for nothing else.
      </p>
    </Section>
  );
}

/** Which contract this build is reading. Stated here as well as in the header. */
function WhereItPoints() {
  if (isConfigError(configResult)) return null;
  const { networkName, contractAddress } = configResult;
  return (
    <dl className="mt-5 border-t border-rule">
      <div className="grid gap-x-6 border-b border-rule py-3 sm:grid-cols-[11rem_1fr]">
        <dt className="text-sm text-ink">Network</dt>
        <dd className="font-mono text-[0.8125rem] text-ink">
          {NETWORK_LABELS[networkName]}
        </dd>
      </div>
      <div className="grid gap-x-6 border-b border-rule py-3 sm:grid-cols-[11rem_1fr]">
        <dt className="text-sm text-ink">Contract</dt>
        <dd className="font-mono text-[0.8125rem] break-all text-ink">{contractAddress}</dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="font-serif text-lg text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[0.9375rem] leading-relaxed text-ink-muted">
        {children}
      </div>
    </section>
  );
}

function Term({ children }: { children: React.ReactNode }) {
  return <em className="text-ink not-italic underline decoration-rule-strong decoration-dotted underline-offset-4">{children}</em>;
}

function Bullet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[11rem_1fr]">
      <span className="stamp text-stamp">{label}</span>
      <span>{children}</span>
    </li>
  );
}
