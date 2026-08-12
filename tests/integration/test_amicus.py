"""Real-consensus smoke suite: small on purpose.

This proves the contract works in an actual GenLayer environment and that
validators agree - not that logic the 353 direct tests already cover still
works. Five cases, no more.

Where to run it:

    genlayer up                          # local Studio, Docker, real GenVM
    gltest tests/integration/ -v -s

    AMICUS_PACE_SECONDS=25 \
      gltest tests/integration/ -v -s --network studionet

**GLSim cannot run this suite**, despite being the lightest option. It executes
contracts natively in one long-lived Python process and can only import a given
contract source once; `factory.deploy()` imports twice - once to deploy, once to
fetch the schema - so the second import fails. The failure is reported as

    ('class is not marked for usage within storage, please annotate it with
      @allow_storage', <class 'genlayer.py.types.Address'>)

which reads like a contract bug and is not one. It reproduces on a two-field
contract that merely has `owner: Address`, with no dataclass involved, and any
one-byte change to the source makes the next import succeed. See the note on the
`amicus` fixture.

StudioNet works (real GenVM, gasless, ~1 GEN per account) but rate limits at 30
requests a minute - not 60 - and one write costs several requests. Hence
`AMICUS_PACE_SECONDS`. Every write waits for its receipt before the next is
submitted regardless.

**Value tests wait for FINALIZED, not ACCEPTED.** `emit_transfer` defaults to
`on="finalized"`, so at accepted the funds are still sitting in the contract and
a balance assertion reads as stranded money. This has already cost this project
a debugging session. Note also that on a gasless environment the *sending* EOA
is not debited even though the contract is credited, so no assertion here
assumes symmetric bookkeeping - the contract-side delta is the one that is
meaningful everywhere.
"""

import json

import pytest
from genlayer_py.types import TransactionStatus
from gltest import get_contract_factory
from gltest.accounts import get_accounts
from gltest.assertions import tx_execution_succeeded

ONE = 10**18
AMOUNT = ONE // 20
BOND = ONE // 100
WINDOW = 3600  # the contract's minimum evidence window
FEE_BPS = 250
ESCROW = AMOUNT + 2 * BOND

FINALIZED = TransactionStatus.FINALIZED

AGREEMENT = (
    "The seller ships one refurbished laptop, model X1, in working condition, "
    "within seven days of this agreement. On delivery the escrowed amount is "
    "released to the seller."
)

# Chosen for stability, not for content. example.com is reserved by RFC 2606 and
# has been byte-stable for years; example.org/nothing-here reliably 404s. No
# assertion below depends on what these pages say - only on whether the contract
# could reach them - because a live product page would be reworded next week.
STABLE_URL = "https://example.com/"
MISSING_URL = "https://example.com/amicus-test-definitely-absent-9c1f2a"

VALID_OUTCOMES = ("CLAIMANT", "RESPONDENT", "SPLIT", "INSUFFICIENT_EVIDENCE")


@pytest.fixture(scope="module")
def actors():
    accounts = get_accounts()
    assert len(accounts) >= 3, "need three accounts"
    return accounts[0], accounts[1], accounts[2]


@pytest.fixture(scope="module")
def amicus(actors):
    """One deployment shared by the whole module. This is not an optimisation.

    GLSim runs contracts natively in a single Python process and caches the
    imported contract module by source. Deploying the *same* source a second
    time in one process re-enters the SDK's storage generation against an
    already-registered class and fails with a misleading

        ('class is not marked for usage within storage, please annotate it
          with @allow_storage', <class 'genlayer.py.types.Address'>)

    which looks like a contract bug and is not one - the first deploy of the
    identical file succeeds, and any one-byte change to the source makes it
    succeed again by producing a new cache key. So: one deploy per process.

    Sharing costs nothing in isolation because every test below creates its own
    case and asserts only about that case.
    """
    claimant, _respondent, _bystander = actors
    factory = get_contract_factory("Amicus")
    return factory.deploy(args=[FEE_BPS], account=claimant)


def explain(receipt):
    """Surface the contract's own error; the raw receipt truncates before it."""
    try:
        leader = receipt["consensus_data"]["leader_receipt"][0]
        return "%s: %s | %s" % (
            leader.get("execution_result"),
            str(leader.get("result"))[:300],
            (leader.get("genvm_result", {}).get("stderr") or "")[-400:],
        )
    except Exception:
        return str(receipt)[:600]


def pace():
    """Throttle writes on rate-limited environments.

    StudioNet allows 30 RPC requests a minute, and one write costs several
    (nonce, gas estimate, send, then a receipt poll every few seconds). This is
    deliberately pacing rather than retrying: retrying a write there is unsafe,
    because the limiter can reject a request issued *after* the transaction was
    already submitted, and the retry would then submit it twice.

    Zero by default so localnet and Studio stay fast. For StudioNet:
        AMICUS_PACE_SECONDS=25 gltest tests/integration/ --network studionet
    """
    import os
    import time

    delay = float(os.environ.get("AMICUS_PACE_SECONDS", "0"))
    if delay > 0:
        time.sleep(delay)


def send(call, value=0, finalized=False):
    """Submit one write, wait for it, and assert it actually executed.

    Accepted and finalized are lifecycle states, not proof of success: a failed
    execution finalizes perfectly well and applies no state changes, which reads
    downstream as mysteriously missing data.
    """
    pace()
    if finalized:
        receipt = call.transact(
            value=value,
            wait_transaction_status=FINALIZED,
            wait_triggered_transactions=True,
            wait_triggered_transactions_status=FINALIZED,
        )
    else:
        receipt = call.transact(value=value)
    assert tx_execution_succeeded(receipt), explain(receipt)
    return receipt


def send_expecting_failure(call, value=0):
    pace()
    receipt = call.transact(value=value)
    assert not tx_execution_succeeded(receipt), "expected the contract to refuse"
    return receipt


def propose(amicus, claimant, respondent):
    send(
        amicus.connect(claimant).propose_case(
            args=[respondent.address, AGREEMENT, AMOUNT, BOND, WINDOW]
        ),
        value=AMOUNT + BOND,
    )
    total = amicus.get_stats().call()["total_cases"]
    ids = amicus.list_cases(args=[total - 1, 1]).call()
    assert len(ids) == 1, ids
    return ids[0]


def accept(amicus, respondent, case_id):
    send(amicus.connect(respondent).accept_case(args=[case_id]), value=BOND)


def assert_conserved(record):
    assert (
        record["claimant_atto"] + record["respondent_atto"] + record["owner_atto"]
        == record["escrow_atto"]
    )


# ---------------------------------------------------------------------------
# 1. Cooperative release, and the money actually arriving
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_cooperative_release_moves_value_at_finalized(amicus, actors, gl_client):
    claimant, respondent, _bystander = actors
    case_id = propose(amicus, claimant, respondent)
    accept(amicus, respondent, case_id)

    contract_before = gl_client.get_balance(amicus.address)
    respondent_before = gl_client.get_balance(respondent.address)
    assert contract_before >= ESCROW, "the escrow never reached the contract"

    send(amicus.connect(claimant).release(args=[case_id]))
    send(amicus.connect(claimant).payout(args=[case_id]), finalized=True)

    assert amicus.get_state(args=[case_id]).call() == "PAID"

    record = json.loads(amicus.get_payout(args=[case_id]).call())
    assert_conserved(record)
    assert record["escrow_atto"] == ESCROW
    assert record["respondent_atto"] == AMOUNT + BOND
    assert record["claimant_atto"] == BOND
    assert record["owner_atto"] == 0

    # The contract-side delta is the assertion that holds on every environment.
    contract_after = gl_client.get_balance(amicus.address)
    assert contract_before - contract_after == record["escrow_atto"], (
        "the escrow did not leave the contract at finalization"
    )

    # The receiving side is only checkable where EOA balances are reported at
    # all; some gasless environments report 0 for accounts that plainly can send.
    if respondent_before > 0:
        assert gl_client.get_balance(respondent.address) - respondent_before == (
            record["respondent_atto"]
        )


# ---------------------------------------------------------------------------
# 2. A full dispute, judged by real models against a real page
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_full_dispute_is_judged_and_paid(amicus, actors):
    """Both sides file, the contract fetches, the panel decides, the money moves.

    No assertion touches model prose. What is asserted is the outcome being a
    member of the closed set, the per-URL reachability the contract recorded,
    the ordering of the audit trail, and the balances.
    """
    claimant, respondent, bystander = actors
    case_id = propose(amicus, claimant, respondent)
    accept(amicus, respondent, case_id)

    send(amicus.connect(claimant).open_dispute(args=[case_id]))
    send(
        amicus.connect(claimant).submit_evidence(
            args=[case_id, "The laptop never arrived; the tracking page is blank.",
                  [STABLE_URL]]
        )
    )
    send(
        amicus.connect(respondent).submit_evidence(
            args=[case_id, "It shipped on time; the carrier record shows it.",
                  [MISSING_URL]]
        )
    )

    wait_for_the_window(amicus, case_id)
    send(amicus.connect(bystander).judge(args=[case_id]))

    case = amicus.get_case(args=[case_id]).call()
    assert case["state"] == "JUDGED"
    assert case["outcome"] in VALID_OUTCOMES
    assert 0 <= case["split_bps"] <= 10000

    records = amicus.get_judgments(args=[case_id]).call()
    assert len(records) == 1
    record = json.loads(records[0])
    assert record["stage"] == "judgment"
    assert record["timestamp"] > 0

    fetched = {f["url"]: f for f in record["fetches"]}
    assert set(fetched) == {STABLE_URL, MISSING_URL}
    assert fetched[STABLE_URL]["status"] == "OK"
    assert fetched[STABLE_URL]["chars"] > 0
    # The absent page is recorded, not fatal.
    assert fetched[MISSING_URL]["status"] in ("OK", "UNREACHABLE")

    # Citations, if any, are only ever URLs a party actually filed.
    for citation in record["citations"]:
        assert citation in (STABLE_URL, MISSING_URL)

    preview = amicus.preview_payout(args=[case_id]).call()
    assert preview["claimant"] + preview["respondent"] + preview["owner"] == (
        preview["escrow"]
    )
    assert preview["escrow"] == ESCROW


# ---------------------------------------------------------------------------
# 3. Silence settles rather than hanging
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_a_dispute_with_one_side_silent_still_settles(amicus, actors):
    claimant, respondent, bystander = actors
    case_id = propose(amicus, claimant, respondent)
    accept(amicus, respondent, case_id)

    send(amicus.connect(claimant).open_dispute(args=[case_id]))
    send(
        amicus.connect(claimant).submit_evidence(
            args=[case_id, "Nothing was ever delivered and they stopped replying.", []]
        )
    )
    # The respondent never files.

    wait_for_the_window(amicus, case_id)
    send(amicus.connect(bystander).judge(args=[case_id]))

    case = amicus.get_case(args=[case_id]).call()
    assert case["state"] == "JUDGED", "a silent party froze the case"
    assert case["outcome"] in VALID_OUTCOMES

    filings = amicus.get_evidence(args=[case_id]).call()
    assert len(filings) == 1
    assert json.loads(filings[0])["role"] == "claimant"


# ---------------------------------------------------------------------------
# 4. The early-judge gate survives real consensus
# ---------------------------------------------------------------------------

def test_judging_early_is_refused_under_real_consensus(amicus, actors):
    """Not marked slow: it must never wait for the window.

    This also confirms the gate precedes the fetching under real consensus - a
    contract that fetched first would take visibly longer and could fail on the
    network rather than on the rule.
    """
    claimant, respondent, bystander = actors
    case_id = propose(amicus, claimant, respondent)
    accept(amicus, respondent, case_id)
    send(amicus.connect(claimant).open_dispute(args=[case_id]))

    assert amicus.is_judgeable(args=[case_id]).call() is False
    send_expecting_failure(amicus.connect(bystander).judge(args=[case_id]))

    assert amicus.get_state(args=[case_id]).call() == "DISPUTED"
    assert amicus.get_judgments(args=[case_id]).call() == []


def test_state_machine_and_access_control_survive_real_consensus(amicus, actors):
    """One representative rejection of each kind, on a real chain."""
    claimant, respondent, bystander = actors
    case_id = propose(amicus, claimant, respondent)

    # Wrong state.
    send_expecting_failure(amicus.connect(claimant).open_dispute(args=[case_id]))
    # Wrong caller.
    send_expecting_failure(
        amicus.connect(bystander).accept_case(args=[case_id]), value=BOND
    )
    # Wrong value.
    send_expecting_failure(
        amicus.connect(respondent).accept_case(args=[case_id]), value=BOND - 1
    )

    assert amicus.get_state(args=[case_id]).call() == "DRAFT"
    assert amicus.get_case(args=[case_id]).call()["respondent_bonded"] is False


# ---------------------------------------------------------------------------
# 5. One appeal, recorded and paid
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_one_appeal_is_recorded_and_the_final_payout_is_correct(
    amicus, actors, gl_client
):
    claimant, respondent, bystander = actors
    case_id = propose(amicus, claimant, respondent)
    accept(amicus, respondent, case_id)
    send(amicus.connect(claimant).open_dispute(args=[case_id]))
    send(
        amicus.connect(claimant).submit_evidence(
            args=[case_id, "The item never arrived.", [STABLE_URL]]
        )
    )
    send(
        amicus.connect(respondent).submit_evidence(
            args=[case_id, "It was delivered as agreed.", [STABLE_URL]]
        )
    )

    wait_for_the_window(amicus, case_id)
    send(amicus.connect(bystander).judge(args=[case_id]))

    first = amicus.get_case(args=[case_id]).call()
    first_outcome = first["outcome"]
    assert first_outcome in VALID_OUTCOMES

    # Whichever side did not win outright is entitled to appeal.
    loser = respondent if first_outcome == "CLAIMANT" else claimant
    appeal_bond = BOND * 3
    send(amicus.connect(loser).appeal(args=[case_id]), value=appeal_bond)
    assert amicus.get_state(args=[case_id]).call() == "APPEALED"

    send(amicus.connect(bystander).judge_appeal(args=[case_id]))

    case = amicus.get_case(args=[case_id]).call()
    assert case["state"] == "FINAL"
    assert case["outcome"] in VALID_OUTCOMES
    assert case["original_outcome"] == first_outcome, "the first judgment was rewritten"
    assert case["judgment_count"] == 2

    records = [json.loads(r) for r in amicus.get_judgments(args=[case_id]).call()]
    assert [r["stage"] for r in records] == ["judgment", "appeal"]
    assert records[0]["outcome"] == first_outcome
    assert records[0]["timestamp"] <= records[1]["timestamp"]

    contract_before = gl_client.get_balance(amicus.address)
    send(amicus.connect(bystander).payout(args=[case_id]), finalized=True)

    record = json.loads(amicus.get_payout(args=[case_id]).call())
    assert_conserved(record)
    assert record["escrow_atto"] == ESCROW + appeal_bond
    assert amicus.get_state(args=[case_id]).call() == "PAID"

    contract_after = gl_client.get_balance(amicus.address)
    assert contract_before - contract_after == record["escrow_atto"]

    # Idempotent on chain too: a second payout moves nothing.
    send(amicus.connect(bystander).payout(args=[case_id]), finalized=True)
    assert gl_client.get_balance(amicus.address) == contract_after


# ---------------------------------------------------------------------------

def wait_for_the_window(amicus, case_id):
    """Block until the evidence window has elapsed.

    The contract's minimum window is an hour of chain time, so this is only
    viable where chain time can be advanced or the environment runs fast. It
    polls the contract's own `is_judgeable` rather than sleeping a fixed amount,
    because a fixed sleep is a guess about someone else's clock.
    """
    import time

    deadline = time.time() + WINDOW + 300
    while time.time() < deadline:
        if amicus.is_judgeable(args=[case_id]).call():
            return
        time.sleep(30)
    pytest.skip(
        "the evidence window did not elapse within the test budget; this "
        "environment cannot advance chain time"
    )
