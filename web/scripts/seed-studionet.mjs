/**
 * Seed a deployed Amicus contract with cases in a spread of lifecycle states.
 *
 * Exists so the docket, the case view and every status badge can be looked at
 * against real chain data rather than one lonely DRAFT. Each case is driven by
 * throwaway keypairs funded through the Studio faucet, so this never touches a
 * real wallet and never asks for a private key.
 *
 * Usage, from the web/ directory (it resolves genlayer-js from web/node_modules):
 *   node scripts/seed-studionet.mjs <contract-address> [rpc-url]
 *
 * This writes permanent state to whatever contract it is pointed at. It is a
 * test-network tool: point it at Localnet or StudioNet, never at a network
 * where the value is real.
 *
 * States it can reach, and the one it cannot:
 *   DRAFT     propose
 *   ACTIVE    propose + accept
 *   DISPUTED  + open_dispute
 *   EVIDENCE  + submit_evidence
 *   RELEASED  + release
 *   PAID      + payout
 *
 * JUDGED, APPEALED and FINAL are deliberately absent. Judging is gated on the
 * evidence window having closed, and the contract's own minimum window is one
 * hour (MIN_EVIDENCE_WINDOW_SEC = 3600), so no script can reach them in a
 * single run without the contract lying about time. Seeding a fake JUDGED state
 * would mean writing an outcome no panel ever reached, which is precisely the
 * thing this contract exists to prevent.
 */

import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const args = process.argv.slice(2);
const CONTRACT = args.find((a) => a.startsWith("0x"));
const RPC = args.find((a) => a.startsWith("http")) ?? "https://studio.genlayer.com/api";
/**
 * Optional --only=ACTIVE,PAID filter. A partial run is normal on a rate-limited
 * endpoint, and re-running everything would duplicate the cases that already
 * succeeded, so the states still needed can be named explicitly.
 */
const only = args
  .find((a) => a.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

if (!CONTRACT || !/^0x[0-9a-fA-F]{40}$/.test(CONTRACT)) {
  console.error("usage: (cd web && node scripts/seed-studionet.mjs <contract-address> [rpc-url])");
  process.exit(1);
}

const GEN = 10n ** 18n;
/** Contract minimum. Anything shorter is rejected by propose_case. */
const MIN_EVIDENCE_WINDOW = 3600n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * StudioNet allows 30 requests per minute, and receipt polling spends that
 * budget fast: an unthrottled run exhausts it on the second case. Every request
 * goes through a minimum-interval gate, and anything that still trips the limit
 * waits the window out rather than failing and leaving a case half-built.
 */
const MIN_REQUEST_GAP_MS = 2500;
let lastRequestAt = 0;

async function paced(fn) {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  return fn();
}

function isRateLimited(error) {
  return /rate limit/i.test(String(error?.message ?? error));
}

async function withRateLimitRetry(fn, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimited(error) || attempt >= attempts) throw error;
      process.stdout.write("(rate limited, waiting 60s) ");
      await sleep(60_000);
    }
  }
}

/** Ask the Studio faucet for test value. The amount must be a number, not a string. */
async function fund(address) {
  return paced(async () => {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sim_fundAccount",
        params: [address, 5000000000000000000],
      }),
    });
    return response.json();
  });
}

function clientFor(account) {
  return createClient({ chain: studionet, endpoint: RPC, account });
}

/** Submit and wait, failing loudly rather than leaving a half-built case. */
async function send(client, label, params) {
  return withRateLimitRetry(async () => {
  const hash = await paced(() => client.writeContract({ address: CONTRACT, ...params }));
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: "ACCEPTED",
    // Poll slowly. The default cadence exhausts the per-minute budget on a
    // single transaction, which then fails the next one.
    interval: 5000,
    retries: 60,
  });
  const result = receipt?.consensus_data?.leader_receipt?.[0]?.execution_result;
  if (result !== "SUCCESS") {
    throw new Error(`${label} did not succeed: ${result ?? "no receipt"}`);
  }
  return hash;
  });
}

async function newFundedPair() {
  const claimant = createAccount(generatePrivateKey());
  const respondent = createAccount(generatePrivateKey());
  await fund(claimant.address);
  await fund(respondent.address);
  // The faucet credits asynchronously; give it a moment before spending.
  await sleep(3000);
  return { claimant, respondent };
}

/**
 * The cases to build. Amounts and bonds differ per case so the docket exercises
 * column alignment and the truncation rules on a range of magnitudes rather
 * than on one repeated figure.
 */
const PLAN = [
  {
    target: "ACTIVE",
    amount: 5n * GEN / 100n, // 0.05
    bond: 2n * GEN / 100n, // 0.02
    agreement:
      "Contractor delivers a migrated staging database with row counts matching " +
      "production, by 14 March. On verification the escrowed amount is released.",
  },
  {
    target: "DISPUTED",
    amount: 25n * GEN / 100n, // 0.25
    bond: 5n * GEN / 100n, // 0.05
    agreement:
      "Supplier ships 200 units of part A-17 to the Rotterdam warehouse before " +
      "the end of Q1. Partial shipment is not acceptance.",
  },
  {
    target: "EVIDENCE",
    amount: GEN / 10n, // 0.1
    bond: 3n * GEN / 100n, // 0.03
    agreement:
      "Developer keeps the checkout service above 99.5% availability for the " +
      "launch weekend, measured by the public status page.",
    filings: [
      {
        side: "claimant",
        statement:
          "The status page recorded two outages during the launch weekend, " +
          "totalling just over four hours. The threshold was not met.",
        urls: ["https://example.com/status-history"],
      },
      {
        side: "respondent",
        statement:
          "Both incidents were upstream provider failures outside the agreed " +
          "scope, and availability of our own service stayed above the threshold.",
        urls: ["https://example.com/incident-report"],
      },
    ],
  },
  {
    target: "RELEASED",
    amount: 2n * GEN / 100n, // 0.02
    bond: GEN / 100n, // 0.01
    agreement:
      "Designer hands over the full icon set as layered SVGs, licensed for " +
      "commercial use, by the end of the month.",
  },
  {
    target: "PAID",
    amount: 5n * GEN / 10n, // 0.5
    bond: GEN / 10n, // 0.1
    agreement:
      "Auditor delivers a written review of the settlement contract, including " +
      "a reproducible test for each finding, within three weeks.",
  },
];

async function buildCase(spec) {
  const { claimant, respondent } = await newFundedPair();
  const asClaimant = clientFor(claimant);
  const asRespondent = clientFor(respondent);

  await send(asClaimant, "propose_case", {
    functionName: "propose_case",
    args: [respondent.address, spec.agreement, spec.amount, spec.bond, MIN_EVIDENCE_WINDOW],
    value: spec.amount + spec.bond,
  });

  // Read the id back rather than assuming: another seed run or a real user may
  // have proposed in between.
  const reader = createClient({ chain: studionet, endpoint: RPC });
  const stats = await withRateLimitRetry(() =>
    paced(() =>
      reader.readContract({
        address: CONTRACT,
        functionName: "get_stats",
        args: [],
        jsonSafeReturn: false,
      }),
    ),
  );
  const caseId = `case-${stats.get("total_cases")}`;

  if (spec.target === "DRAFT") return { caseId, state: spec.target };

  await send(asRespondent, "accept_case", {
    functionName: "accept_case",
    args: [caseId],
    value: spec.bond,
  });
  if (spec.target === "ACTIVE") return { caseId, state: spec.target };

  if (spec.target === "RELEASED" || spec.target === "PAID") {
    // Cooperative release is claimant-authorized: it pays the escrowed amount to
    // the respondent, so only the claimant (whose funds move) may trigger it.
    // The contract rejects a respondent-initiated release.
    await send(asClaimant, "release", {
      functionName: "release",
      args: [caseId],
      value: 0n,
    });
    if (spec.target === "RELEASED") return { caseId, state: spec.target };

    await send(asClaimant, "payout", {
      functionName: "payout",
      args: [caseId],
      value: 0n,
    });
    return { caseId, state: spec.target };
  }

  await send(asClaimant, "open_dispute", {
    functionName: "open_dispute",
    args: [caseId],
    value: 0n,
  });
  if (spec.target === "DISPUTED") return { caseId, state: spec.target };

  for (const filing of spec.filings ?? []) {
    const client = filing.side === "claimant" ? asClaimant : asRespondent;
    await send(client, `submit_evidence (${filing.side})`, {
      functionName: "submit_evidence",
      args: [caseId, filing.statement, filing.urls],
      value: 0n,
    });
  }
  return { caseId, state: spec.target };
}

console.log(`seeding ${CONTRACT} via ${RPC}\n`);
const selected = only ? PLAN.filter((p) => only.includes(p.target)) : PLAN;
const results = [];
for (const [index, spec] of selected.entries()) {
  process.stdout.write(`[${index + 1}/${selected.length}] ${spec.target.padEnd(9)} ... `);
  try {
    const built = await buildCase(spec);
    console.log(`${built.caseId} ok`);
    results.push(built);
  } catch (error) {
    console.log(`FAILED: ${String(error.message).split("\n")[0]}`);
    results.push({ caseId: "-", state: spec.target, error: true });
  }
}

console.log("\nsummary");
for (const r of results) {
  console.log(`  ${r.caseId.padEnd(8)} ${r.state}${r.error ? "  (failed)" : ""}`);
}
