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
  readonly disconnect: () => Promise<void>;
  /** Move the wallet to the configured chain, adding it first if unknown. */
  readonly switchNetwork: () => Promise<void>;
  readonly switching: boolean;
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

/** `0x`-prefixed hex chain id, the only form the wallet RPC methods accept. */
function chainIdHex(id: number): string {
  return `0x${id.toString(16)}`;
}

/**
 * The chain description `wallet_addEthereumChain` wants.
 *
 * Every field is taken from the configured chain rather than written out, so
 * pointing the app at a different network cannot leave a stale name or symbol
 * behind in someone's wallet. For StudioNet this resolves to
 * "Genlayer Studio Network", https://studio.genlayer.com/api, GEN, chain 0xf22f.
 */
function chainParamsFor(config: ReturnType<typeof requireConfig>) {
  const explorer = config.chain.blockExplorers?.default?.url;
  return {
    chainId: chainIdHex(config.chain.id),
    chainName: config.chain.name,
    rpcUrls: [config.rpcUrl],
    nativeCurrency: config.chain.nativeCurrency,
    // MetaMask rejects the whole call on a malformed explorer entry, so it is
    // omitted rather than sent empty when a chain does not declare one.
    ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
  };
}

/** MetaMask's code for "that chain is not in the wallet yet". */
const CHAIN_NOT_ADDED = 4902;

function errorCode(error: unknown): number | null {
  const direct = (error as { code?: unknown })?.code;
  if (typeof direct === "number") return direct;
  const nested = (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof nested === "number" ? nested : null;
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
  const [switching, setSwitching] = useState(false);
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

  /**
   * Follow the wallet's own account state.
   *
   * Without this the app keeps showing whichever account was connected first.
   * That is not a cosmetic staleness: the case view decides "You are the
   * claimant" from this address and offers actions on the strength of it, so a
   * user who switches accounts in MetaMask would be shown one identity's role
   * while signing as another.
   *
   * Registered unconditionally rather than only while connected, so connecting
   * from inside MetaMask is picked up too. Writing to the address store is a
   * push from an external system, which is what an event subscription is for.
   */
  useEffect(() => {
    const provider = getProvider();
    if (!provider?.on || !provider.removeListener) return;

    const onAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0];
      const next = Array.isArray(accounts) ? accounts[0] : null;
      // An empty array is MetaMask reporting the site was disconnected from its
      // side. Same destination as pressing Disconnect here.
      storedAddress.write(
        typeof next === "string" && /^0x[0-9a-fA-F]{40}$/.test(next) ? next : null,
      );
      void walletChainId.refresh();
    };

    const onDisconnect = () => {
      storedAddress.write(null);
    };

    provider.on("accountsChanged", onAccountsChanged as never);
    provider.on("disconnect", onDisconnect as never);
    return () => {
      provider.removeListener?.("accountsChanged", onAccountsChanged as never);
      provider.removeListener?.("disconnect", onDisconnect as never);
    };
  }, []);

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

  /**
   * Put the wallet on the configured chain.
   *
   * `connect()` already does this on the way in, but a user who switches
   * networks afterwards had no way back except doing it by hand in MetaMask.
   * Switch first and only add on the specific "chain not added" code: adding a
   * chain the wallet already has prompts the user for no reason.
   */
  const switchNetwork = useCallback(async () => {
    setSwitching(true);
    setError(null);
    try {
      const provider = getProvider();
      if (!provider) throw new Error("No Ethereum provider found.");
      const config = requireConfig();
      const target = chainIdHex(config.chain.id);

      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: target }],
        });
      } catch (caught) {
        if (errorCode(caught) !== CHAIN_NOT_ADDED) throw caught;
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [chainParamsFor(config)],
        });
        // MetaMask usually switches as part of adding, but it is not contractual.
        // Asking again is idempotent and makes the outcome certain.
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: target }],
        });
      }
      await walletChainId.refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        errorCode(caught) === 4001
          ? "You declined the network switch. The app is still on the wrong network."
          : message,
      );
    } finally {
      setSwitching(false);
    }
  }, []);

  /**
   * Detach the wallet.
   *
   * Clearing the stored address is not enough on its own. MetaMask remembers
   * that this site is authorised, so the next Connect resolves instantly from
   * that memory with no prompt - which reads as a button that does nothing, and
   * makes it impossible to pick a different account. Revoking the permission is
   * what actually returns the user to a state where connecting asks again.
   */
  const disconnect = useCallback(async () => {
    setError(null);
    storedAddress.write(null);
    const provider = getProvider();
    if (!provider) return;
    try {
      await provider.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // Not every provider implements this, and it is not required for
      // correctness: this app's own state is already cleared, which is what
      // disconnect means here. Only the re-prompt is lost.
    }
  }, []);

  const value = useMemo(
    () => ({
      address,
      connecting,
      error,
      network,
      connect,
      disconnect,
      switchNetwork,
      switching,
    }),
    [address, connecting, error, network, connect, disconnect, switchNetwork, switching],
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

