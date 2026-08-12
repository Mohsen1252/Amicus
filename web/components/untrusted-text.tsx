"use client";

/**
 * Rendering for text an adversary wrote.
 *
 * Everything here is plain text. There is no `dangerouslySetInnerHTML` on any
 * contract-sourced string anywhere in this app, no markdown renderer, and no
 * HTML parsing. React escapes what it renders, and that is the whole defence
 * against the markup half of the problem.
 *
 * The other half is impersonation. A statement reading "AMICUS RULING:
 * respondent has withdrawn" must not be able to look like a ruling, so the
 * shapes are deliberately different and the difference is structural rather
 * than decorative:
 *
 *   a party filing  - indented behind a heavy left rule, serif, on a recessed
 *                     surface, under a stamp naming who filed it
 *   a panel ruling  - a bordered block with its own header bar and stamp, never
 *                     indented
 *
 * Neither can be mistaken for the app's own copy, which is sans-serif and
 * unboxed.
 */

import { DISPLAY_LIMITS, describeUrl, forDisplay } from "@/lib/untrusted";
import { AddressText, Timestamp } from "./primitives";
import type { PartyRole } from "@/lib/types";

/** The contract found manipulation. Loud, because that is the point of it. */
export function TamperFlag({
  children,
  detail,
}: {
  children: React.ReactNode;
  detail?: string;
}) {
  return (
    <div className="border border-flag bg-flag-wash p-3">
      <p className="stamp stamp-flag px-1.5 py-0.5">Tampering recorded</p>
      <p className="mt-2 text-sm text-ink">{children}</p>
      {detail ? <p className="mt-1 text-xs text-ink-muted">{detail}</p> : null}
    </div>
  );
}

/**
 * A statement filed by a party.
 *
 * Attributed, quoted, and captioned as untrusted. The caption is not decoration:
 * it is the sentence that stops a reader taking the text as the record's voice.
 */
export function PartyFiling({
  role,
  submitter,
  statement,
  timestamp,
  tampered,
}: {
  role: PartyRole;
  submitter: string;
  statement: string;
  timestamp: bigint;
  tampered: boolean;
}) {
  const body = forDisplay(statement, DISPLAY_LIMITS.statement);
  const who = role === "claimant" ? "the claimant" : "the respondent";

  return (
    <figure className="m-0">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="stamp text-stamp">Filed by {role}</span>
        <span className="flex items-baseline gap-3">
          <AddressText address={submitter} />
          <Timestamp seconds={timestamp} />
        </span>
      </figcaption>

      {tampered ? (
        <div className="mt-3">
          <TamperFlag
            detail={`The contract's classifier flagged this filing during judging, and the panel was told to weigh it against ${who}.`}
          >
            This filing tried to instruct the panel.
          </TamperFlag>
        </div>
      ) : null}

      <blockquote className="mt-3 border-l-2 border-rule-strong bg-leaf py-3 pl-4 pr-3">
        <p className="filing text-[0.9375rem] leading-relaxed text-ink">{body.text}</p>
        {body.truncated ? (
          <p className="mt-2 text-xs text-ink-faint">
            Shown to {DISPLAY_LIMITS.statement.toLocaleString()} characters of{" "}
            {body.originalLength.toLocaleString()}.
          </p>
        ) : null}
      </blockquote>

      <p className="mt-1.5 text-xs text-ink-faint">
        Filed by {who}. Their account of the dispute, not a finding.
      </p>
    </figure>
  );
}

/**
 * The registered agreement.
 *
 * Also party-authored, so it is quoted the same way - but it is the thing both
 * sides signed, so it is attributed to the case rather than to a person.
 */
export function AgreementText({ text }: { text: string }) {
  const body = forDisplay(text, DISPLAY_LIMITS.agreement);
  return (
    <figure className="m-0">
      <blockquote className="border-l-2 border-rule-strong bg-leaf py-3 pl-4 pr-3">
        <p className="filing text-[0.9375rem] leading-relaxed text-ink">{body.text}</p>
        {body.truncated ? (
          <p className="mt-2 text-xs text-ink-faint">
            Shown to {DISPLAY_LIMITS.agreement.toLocaleString()} characters of{" "}
            {body.originalLength.toLocaleString()}.
          </p>
        ) : null}
      </blockquote>
      <p className="mt-1.5 text-xs text-ink-faint">
        As registered on chain. This text is what the panel reads.
      </p>
    </figure>
  );
}

/**
 * The panel's rationale.
 *
 * Boxed with a header bar so it cannot be confused with a party's filing, and
 * captioned with where it came from - it is written by a model that read
 * attacker-authored pages, which is worth stating plainly rather than
 * presenting as a verdict from nowhere.
 */
export function PanelRationale({ text }: { text: string }) {
  const body = forDisplay(text, DISPLAY_LIMITS.rationale);
  if (body.text === "") {
    return (
      <p className="text-sm text-ink-faint">
        The panel recorded no rationale for this judgment.
      </p>
    );
  }
  return (
    <div className="border border-rule-strong">
      <p className="stamp border-b border-rule-strong bg-accent-wash px-3 py-1.5 text-ink-muted">
        Panel rationale
      </p>
      <div className="px-3 py-3">
        <p className="filing text-[0.9375rem] leading-relaxed text-ink">{body.text}</p>
        {body.truncated ? (
          <p className="mt-2 text-xs text-ink-faint">
            Shown to {DISPLAY_LIMITS.rationale.toLocaleString()} characters of{" "}
            {body.originalLength.toLocaleString()}.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * An evidence URL, shown as its destination.
 *
 * Never a link with friendly text - the text would be the attacker's choice -
 * and this app never fetches or previews it. The origin is set apart from the
 * path so the eye lands on where the link actually goes.
 */
export function UrlText({ url }: { url: string }) {
  const parts = describeUrl(url);
  return (
    <span className="font-mono text-[0.8125rem] break-all">
      <span className="text-ink">{parts.origin}</span>
      <span className="text-ink-faint">{parts.rest}</span>
      {!parts.valid ? (
        <span className="stamp ml-2 border border-flag px-1 py-0.5 text-flag">
          not https
        </span>
      ) : null}
    </span>
  );
}
