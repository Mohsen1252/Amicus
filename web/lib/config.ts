/**
 * The single place the app learns where it is pointed.
 *
 * Nothing else in the codebase names an address or a network. Changing either
 * is a change to `.env.local`, not to a component.
 *
 * Misconfiguration is treated as fatal rather than empty. An app pointed at a
 * wrong or missing address would otherwise render a perfectly calm "no disputes
 * yet", which is the single most dangerous thing this interface could do: it
 * looks like an answer.
 */

import { localnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";

export type GenLayerChain =
  | typeof localnet
  | typeof studionet
  | typeof testnetAsimov
  | typeof testnetBradbury;

/**
 * Networks this app can be pointed at, keyed by the same names the project's
 * gltest.config.yaml uses, so the two configs are read the same way.
 */
const NETWORKS = {
  localnet,
  studionet,
  testnet_asimov: testnetAsimov,
  testnet_bradbury: testnetBradbury,
} satisfies Record<string, GenLayerChain>;

export type NetworkName = keyof typeof NETWORKS;

/** Networks where the money is not real. Displayed as such, prominently. */
const TEST_NETWORKS: ReadonlySet<NetworkName> = new Set([
  "localnet",
  "studionet",
  "testnet_asimov",
  "testnet_bradbury",
]);

export type AppConfig = {
  readonly contractAddress: `0x${string}`;
  readonly networkName: NetworkName;
  readonly chain: GenLayerChain;
  readonly rpcUrl: string;
  readonly isTestNetwork: boolean;
};

export type ConfigError = {
  readonly variable: string;
  readonly problem: string;
  readonly fix: string;
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function readConfig(): AppConfig | ConfigError {
  // Next.js inlines NEXT_PUBLIC_* at build time only for statically analysable
  // member expressions, so these must be written out in full rather than looked
  // up dynamically.
  const rawAddress = process.env.NEXT_PUBLIC_AMICUS_ADDRESS;
  const rawNetwork = process.env.NEXT_PUBLIC_AMICUS_NETWORK;
  const rawRpcUrl = process.env.NEXT_PUBLIC_AMICUS_RPC_URL;

  if (!rawAddress || rawAddress.trim() === "") {
    return {
      variable: "NEXT_PUBLIC_AMICUS_ADDRESS",
      problem: "is not set, so there is no contract to read.",
      fix: "Copy .env.example to .env.local and set it to the deployed Amicus address.",
    };
  }
  const address = rawAddress.trim();
  if (!ADDRESS_PATTERN.test(address)) {
    return {
      variable: "NEXT_PUBLIC_AMICUS_ADDRESS",
      problem: `is "${address}", which is not a 20-byte hex address.`,
      fix: "Set it to an address of the form 0x followed by 40 hex characters.",
    };
  }

  const networkName = (rawNetwork?.trim() || "localnet") as NetworkName;
  if (!(networkName in NETWORKS)) {
    return {
      variable: "NEXT_PUBLIC_AMICUS_NETWORK",
      problem: `is "${networkName}", which is not a network this app knows.`,
      fix: `Set it to one of: ${Object.keys(NETWORKS).join(", ")}.`,
    };
  }

  const chain = NETWORKS[networkName];
  const rpcUrl = rawRpcUrl?.trim() || chain.rpcUrls.default.http[0];
  if (!rpcUrl) {
    return {
      variable: "NEXT_PUBLIC_AMICUS_RPC_URL",
      problem: `is not set and ${networkName} has no default endpoint.`,
      fix: "Set it to the JSON-RPC endpoint of the node you are reading from.",
    };
  }

  return {
    contractAddress: address as `0x${string}`,
    networkName,
    chain,
    rpcUrl,
    isTestNetwork: TEST_NETWORKS.has(networkName),
  };
}

const result = readConfig();

export function isConfigError(value: AppConfig | ConfigError): value is ConfigError {
  return "problem" in value;
}

/** The config, or the reason there isn't one. Never a silent default. */
export const configResult: AppConfig | ConfigError = result;

/**
 * The config, for code that only runs once the app has confirmed it is
 * configured. Throws rather than returning a partial object, so a missing
 * address can never reach a contract call.
 */
export function requireConfig(): AppConfig {
  if (isConfigError(result)) {
    throw new Error(
      `Amicus is not configured: ${result.variable} ${result.problem} ${result.fix}`,
    );
  }
  return result;
}

/** Human label for the network, shown in the UI at all times. */
export const NETWORK_LABELS: Record<NetworkName, string> = {
  localnet: "Localnet",
  studionet: "StudioNet",
  testnet_asimov: "Testnet Asimov",
  testnet_bradbury: "Testnet Bradbury",
};

/**
 * The name genlayer-js's own `connect()` uses for each network.
 *
 * These are not the names this app uses, and the difference matters.
 * `client.connect(network)` looks its argument up in a private table keyed
 * `localnet | studionet | testnetAsimov | testnetBradbury`, and **defaults to
 * "studionet"** when the argument is omitted. Omitting it does not mean "use
 * the chain this client was built with": it means "add StudioNet to MetaMask
 * and switch to it", regardless of what this app is pointed at.
 */
export const CONNECT_NETWORK_NAMES: Record<NetworkName, string> = {
  localnet: "localnet",
  studionet: "studionet",
  testnet_asimov: "testnetAsimov",
  testnet_bradbury: "testnetBradbury",
};

/**
 * Whether a matching wallet chain id actually identifies this network.
 *
 * Asimov and Bradbury both report chain id 4221, so a match proves the wallet
 * is on one of the two and not which. Where that is so the app reports the
 * check as inconclusive rather than claiming a match it cannot vouch for.
 */
export function chainIdIsAmbiguous(networkName: NetworkName): boolean {
  return networkName === "testnet_asimov" || networkName === "testnet_bradbury";
}
