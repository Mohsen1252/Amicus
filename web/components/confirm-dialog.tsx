"use client";

/**
 * The last thing between a person and something they cannot undo.
 *
 * Built on the native `<dialog>` element rather than a component library: it
 * gives a real focus trap, Escape handling, inert background and the right
 * ARIA semantics with no dependency at all, which is the leanest correct answer
 * for the one modal this app has.
 *
 * The consequence is stated in full, in the interface's voice, before the
 * signature is requested - never after.
 */

import { useEffect, useRef } from "react";

import { Amount, ExactAmount } from "./primitives";

export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  value,
  extra,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  consequence: string;
  confirmLabel: string;
  value?: bigint;
  extra?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClose={onCancel}
      aria-labelledby="confirm-title"
      className="w-[min(32rem,calc(100vw-2rem))] border border-rule-strong bg-paper p-0 text-ink backdrop:bg-black/60"
    >
      <div className="border-b border-rule bg-leaf px-4 py-2">
        <p className="stamp text-ink-muted">Confirm before signing</p>
      </div>
      <div className="px-4 py-4">
        <h2 id="confirm-title" className="font-serif text-lg text-ink">
          {title}
        </h2>
        <p className="mt-2 text-sm text-ink">{consequence}</p>

        {value !== undefined && value > 0n ? (
          <div className="mt-4 border border-rule bg-leaf px-3 py-2">
            <p className="text-xs text-ink-faint">Leaving your wallet now</p>
            <p className="mt-0.5">
              <Amount atto={value} className="text-base text-ink" />
            </p>
            <ExactAmount atto={value} />
          </div>
        ) : null}

        {extra}

        <p className="mt-4 border-t border-rule pt-3 text-xs text-ink-faint">
          This cannot be undone, and the contract keeps a permanent record of it.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-rule px-4 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="border border-rule px-3 py-1.5 text-sm text-ink-muted hover:border-rule-strong hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="border border-accent bg-accent-wash px-3 py-1.5 text-sm text-accent hover:bg-accent hover:text-paper"
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
