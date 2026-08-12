"use client";

/**
 * The masthead: what this is, which network it is reading, and who is connected.
 *
 * The network is always on screen and never abbreviated away. Someone looking at
 * testnet money must never have to wonder, and someone looking at real money
 * even less so.
 */

import Link from "next/link";
import { useSyncExternalStore } from "react";

import { NETWORK_LABELS, configResult, isConfigError } from "@/lib/config";
import { darkMode } from "@/lib/client-store";
import { shortenAddress, spellAddress } from "@/lib/untrusted";
import { networkWarning, useWallet } from "./wallet";

export function SiteHeader() {
  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule py-5">
        <div>
          <Link href="/" className="inline-block">
            <span className="font-serif text-xl tracking-tight text-ink">Amicus</span>
          </Link>
          <p className="mt-0.5 text-xs text-ink-faint">
            Agreements in plain language, settled on the record.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <Link
            href="/about"
            className="border border-rule px-2 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
          >
            How it works
          </Link>
          <Link
            href="/propose"
            className="border border-rule px-2 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
          >
            Propose a case
          </Link>
          <NetworkBadge />
          <ThemeToggle />
          <ConnectControl />
        </div>
      </header>
      <NetworkWarning />
    </>
  );
}

/**
 * A wallet on the wrong chain, stated before it costs anything.
 *
 * genlayer-js raises this only at send time, and only on the non-Studio
 * networks. By then the user has already written a statement or filled in a
 * proposal. Here it is in front of them from the moment it becomes true.
 */
function NetworkWarning() {
  const { address, network, switchNetwork, switching } = useWallet();
  if (!address) return null;
  const warning = networkWarning(network);
  if (!warning) return null;
  return (
    <div
      role="alert"
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border border-flag bg-flag-wash px-3 py-2"
    >
      <p className="text-sm text-ink">
        <span className="stamp mr-2 text-flag">Wrong network</span>
        {warning}
      </p>
      {/* Telling someone to switch without offering to do it leaves them to
          find the right chain by hand. This asks the wallet directly. */}
      <button
        type="button"
        onClick={() => void switchNetwork()}
        disabled={switching}
        className="ml-auto shrink-0 border border-flag px-2.5 py-1 text-xs text-flag hover:bg-flag/10 disabled:opacity-60"
      >
        {switching ? "Switching…" : "Switch network"}
      </button>
    </div>
  );
}

function NetworkBadge() {
  if (isConfigError(configResult)) return null;
  const { networkName, contractAddress, isTestNetwork } = configResult;
  return (
    <span
      className={`stamp inline-flex items-center gap-2 border px-2 py-1 ${
        isTestNetwork ? "border-rule-strong text-ink-muted" : "border-flag text-flag"
      }`}
      title={`Contract ${contractAddress}`}
    >
      <span>{NETWORK_LABELS[networkName]}</span>
      <span aria-hidden className="text-rule-strong">
        /
      </span>
      <span className="normal-case tracking-normal">
        {isTestNetwork ? "test value" : "live value"}
      </span>
    </span>
  );
}

function ThemeToggle() {
  // The class on <html> is the source of truth - an inline script sets it before
  // paint - so this subscribes to that rather than keeping a second copy.
  const dark = useSyncExternalStore(
    darkMode.subscribe,
    darkMode.getSnapshot,
    darkMode.getServerSnapshot,
  );

  return (
    <button
      type="button"
      className="border border-rule px-2 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
      aria-pressed={dark}
      onClick={() => darkMode.set(!dark)}
    >
      <span className="sr-only">Switch to </span>
      {dark ? "Light" : "Dark"}
      <span className="sr-only"> theme</span>
    </button>
  );
}

function ConnectControl() {
  const { address, connecting, error, connect, disconnect, needsAuthorization } =
    useWallet();

  if (address) {
    return (
      <span className="flex items-center gap-2">
        <span
          className="font-mono text-xs text-ink"
          title={address}
          aria-label={spellAddress(address)}
        >
          {shortenAddress(address)}
        </span>
        <button
          type="button"
          onClick={() => void disconnect()}
          className="border border-rule px-2 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
        >
          Disconnect
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      {/*
        A wallet that granted no account is not a failure, so it does not get
        the alarm colour. It is a step the user has not taken yet, phrased as
        the step. The raw error is reserved for the cases that really are one -
        no provider, or a Snap that will not install.
      */}
      {needsAuthorization ? (
        <span className="max-w-xs text-xs text-ink-muted">
          MetaMask has not shared an account with this site yet.
        </span>
      ) : error ? (
        <span className="max-w-xs text-xs text-flag" role="alert">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void connect()}
        disabled={connecting}
        className="border border-accent px-2 py-1 text-xs text-accent hover:bg-accent-wash disabled:opacity-60"
      >
        {connecting
          ? "Connecting…"
          : needsAuthorization
            ? "Click to Authorize Account"
            : "Connect wallet"}
      </button>
    </span>
  );
}
