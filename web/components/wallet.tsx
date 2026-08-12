"use client";

/**
 * The connected account, and which network it is actually on.
 *
 * Reads never touch this: browsing cases and judgments is public and works with
 * no wallet at all. Only the party actions need an account, and they ask for it
 * at the point of use rather than the app gating itself behind a connect button.
 *
 * GenLayer accounts come from the MetaMask Snap, which genlayer-js drives via
 * `client.connect()`. There is no private key anywhere in this app and no
 * fallback that would need one.
 *
 * Two things about `connect()` are worth stating, because both are quiet:
 *
 *  - Its network argument defaults to "studionet". Calling `client.connect()`
 *    bare does not connect to the chain the client was built with; it switches
 *    MetaMask to StudioNet. The configured network is passed explicitly.
 *
 *  - genlayer-js only verifies the wallet's chain for non-Studio networks, and
 *    only at the moment a transaction is sent. On Localnet and StudioNet it
 *    never checks at all. So the chain is checked here, on connect and on every
 *    subsequent `chainChanged`, and a mismatch is surfaced before someone fills
 *    in a form rather than after they sign.
 */

import { createClient } from "genlayer-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { Address } from "viem";

import {
  CONNECT_NETWORK_NAMES,
  NETWORK_LABELS,
  chainIdIsAmbiguous,
  requireConfig,
} from "@/lib/config";
import { storedAddress, walletChainId } from "@/lib/client-store";

/**
 * What the wallet's chain check established.
 *
 * "inconclusive" is a real answer and not a soft "match": on the testnets the
 * chain id does not distinguish Asimov from Bradbury, and claiming a match
 * there would be asserting something unverified about which network holds the
 * user's money.
 */
export type NetworkStatus =
  | { readonly kind: "unchecked" }
  | { readonly kind: "match" }
  | { readonly kind: "inconclusive"; readonly chainId: number }
  | { readonly kind: "mismatch"; readonly walletChainId: number; readonly expectedChainId: number };

type WalletState = {
  readonly address: Address | null;
  readonly connecting: boolean;
  readonly error: string | null;
  readonly network: NetworkStatus;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
};

const WalletContext = createContext<WalletState | null>(null);

type EthereumProvider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
};

function getProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  const injected = (window as { ethereum?: EthereumProvider }).ethereum;
  return injected ?? null;
}

/**
 * Compare the wallet's chain against the configured one.
 *
 * Pure, so the comparison that decides whether to warn someone about their
 * funds can be reasoned about on its own.
 */
function networkStatusFor(
  address: Address | null,
  chainId: number | null,
): NetworkStatus {
  if (!address || chainId === null) return { kind: "unchecked" };
  const config = requireConfig();
  if (chainId !== config.chain.id) {
    return { kind: "mismatch", walletChainId: chainId, expectedChainId: config.chain.id };
  }
  return chainIdIsAmbiguous(config.networkName)
    ? { kind: "inconclusive", chainId }
    : { kind: "match" };
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The connected address is browser state, not React state, so it is read
  // from its store rather than copied into an effect. A reload keeps the role
  // the viewer had; the address is not a credential and only decides what the
  // UI offers, since every action is checked again on chain.
  const raw = useSyncExternalStore(
    storedAddress.subscribe,
    storedAddress.getSnapshot,
    storedAddress.getServerSnapshot,
  );
  const address =
    raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw as Address) : null;

  // The provider's chain, read from its store rather than mirrored into state.
  // It pushes `chainChanged`, so a copy kept in React state would be stale
  // exactly during a network switch - the one moment this has to be right.
  const chainId = useSyncExternalStore(
    walletChainId.subscribe,
    walletChainId.getSnapshot,
    walletChainId.getServerSnapshot,
  );

  // Ask once there is an account to check. The subscription keeps it current
  // from then on, so this does not re-run per render.
  useEffect(() => {
    if (address) void walletChainId.refresh();
  }, [address]);

  // Derived, not stored. With no account there is nothing to check, and that is
  // a fact about the current address rather than a state to be reset into -
  // which also means a result from a previous connection can never be read as
  // if it described this one.
  const network: NetworkStatus = networkStatusFor(address, chainId);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error(
          "No Ethereum provider found. GenLayer accounts come from the MetaMask Snap, so MetaMask must be installed.",
        );
      }
      const config = requireConfig();
      const client = createClient({
        chain: config.chain,
        endpoint: config.rpcUrl,
        provider,
      });
      // Explicit. The default is "studionet", not this client's chain.
      await client.connect(CONNECT_NETWORK_NAMES[config.networkName] as never);
      const accounts = await client.getAddresses();
      const account = accounts?.[0];
      if (!account) {
        throw new Error("The wallet connected but returned no account.");
      }
      storedAddress.write(account);
      await walletChainId.refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        /snap/i.test(message) && /install|not found/i.test(message)
          ? "The GenLayer Snap is not installed in MetaMask. Install it, then connect again."
          : message,
      );
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setError(null);
    storedAddress.write(null);
  }, []);

  const value = useMemo(
    () => ({ address, connecting, error, network, connect, disconnect }),
    [address, connecting, error, network, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used inside WalletProvider");
  }
  return context;
}

/**
 * The sentence to show for a network problem, or null when there is none.
 *
 * Kept next to the check rather than in the component so the docket, the case
 * view and the propose form all say the same thing about the same condition.
 */
export function networkWarning(network: NetworkStatus): string | null {
  if (network.kind === "mismatch") {
    const config = requireConfig();
    return (
      `Your wallet is on chain ${network.walletChainId}, but this app reads ` +
      `${NETWORK_LABELS[config.networkName]} (chain ${network.expectedChainId}). ` +
      `Switch networks in MetaMask before acting on a case.`
    );
  }
  return null;
}
