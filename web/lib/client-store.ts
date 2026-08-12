"use client";

/**
 * Tiny subscribable wrappers around the two browser stores this app reads.
 *
 * Both are genuinely external state, so they are consumed with
 * `useSyncExternalStore` rather than mirrored into React state from an effect.
 * That keeps the server snapshot explicit - which matters here, because
 * localStorage does not exist during SSR and guessing at it is how hydration
 * mismatches start.
 */

function createStore<T>(read: () => T, serverValue: T) {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: read,
    getServerSnapshot: () => serverValue,
    notify() {
      for (const listener of listeners) listener();
    },
  };
}

const WALLET_KEY = "amicus-wallet-address";

export const storedAddress = {
  ...createStore<string | null>(() => {
    try {
      return window.localStorage.getItem(WALLET_KEY);
    } catch {
      return null;
    }
  }, null),
  write(value: string | null) {
    try {
      if (value) window.localStorage.setItem(WALLET_KEY, value);
      else window.localStorage.removeItem(WALLET_KEY);
    } catch {
      // A blocked localStorage only costs session restoration.
    }
    storedAddress.notify();
  },
};

/**
 * The wallet's current chain id.
 *
 * Genuinely external state, like the two above, and read the same way. The
 * provider is the source of truth and it pushes `chainChanged`, so mirroring it
 * into React state from an effect would be keeping a second copy that is stale
 * exactly when it matters - during a network switch.
 *
 * The value is null until something asks the provider for it. `refresh()` does
 * the asking; the subscription keeps it current afterwards.
 */
type EthereumProvider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
};

function getProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  return (window as { ethereum?: EthereumProvider }).ethereum ?? null;
}

let currentChainId: number | null = null;
let listening = false;

export const walletChainId = {
  ...createStore<number | null>(() => currentChainId, null),

  /** Ask the provider, and start listening for changes if not already. */
  async refresh() {
    const provider = getProvider();
    if (!provider) return;

    if (!listening && provider.on) {
      listening = true;
      provider.on("chainChanged", () => {
        void walletChainId.refresh();
      });
    }

    let next: number | null = null;
    try {
      const raw = await provider.request({ method: "eth_chainId" });
      const parsed = typeof raw === "string" ? Number.parseInt(raw, 16) : Number.NaN;
      next = Number.isFinite(parsed) ? parsed : null;
    } catch {
      // A provider that will not answer is not a mismatch. Reporting nothing is
      // correct; guessing would put a false warning in front of the user.
      next = null;
    }

    if (next === currentChainId) return;
    currentChainId = next;
    walletChainId.notify();
  },
};

const THEME_KEY = "amicus-theme";

export const darkMode = {
  ...createStore<boolean>(
    () => document.documentElement.classList.contains("dark"),
    false,
  ),
  set(next: boolean) {
    document.documentElement.classList.toggle("dark", next);
    try {
      window.localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      // Preference simply will not persist.
    }
    darkMode.notify();
  },
};
