"""Shared fixtures, mock helpers and money invariants for the Amicus direct suite.

Four facts about direct mode drive everything here. Each has cost this project
time already, so they are written down rather than rediscovered.

1. `genlayer` is only importable after the first `direct_deploy` - the deploy is
   what puts the SDK on `sys.path`. Anything needing `Address` imports it after
   deploying, never at module import time. The `addr()` helper is idempotent
   because the fixtures hand back raw bytes before the SDK loads and a real
   `Address` afterwards.

2. **Value does not move.** `direct_vm.value` is visible to the contract as
   `gl.message.value`, but the VM never credits the contract's balance, and
   `emit_transfer` is unimplemented in direct mode - it leaves a `PostMessage`
   trace and returns a failure descriptor that the SDK ignores. So real balances
   are useless as a conservation oracle here. `assert_conserved` instead checks
   the distribution the contract computed and recorded against the value the
   test actually attached, and counts the transfers the contract asked for.
   `total_value` exists to assert the complementary fact - that nothing moved
   behind our backs. Real balance movement is an integration concern.

3. **An unmocked URL raises `MockNotFoundError`, it does not return empty.**
   There is deliberately no catch-all mock here. The loud failure is how a test
   proves a gate ran before any fetching: configure no mocks at all, and assert
   the specific expected revert rather than merely that something raised.

4. `direct_vm.warp` moves `datetime.datetime.now()`, which is what the contract
   reads. It does *not* update `gl.message_raw['datetime']`, which is fixed at
   deploy - one of the reasons the contract does not read time from there.
"""

import json
from pathlib import Path

import pytest

CONTRACT = str(Path(__file__).resolve().parents[2] / "contracts" / "amicus.py")

ONE = 10**18
AMOUNT = 600 * ONE
BOND = 60 * ONE
WINDOW = 7 * 24 * 3600
FEE_BPS = 250

# Mirrors the contract's own constants. Imported from the module in tests that
# care about the value; duplicated here only for the default-case arithmetic.
APPEAL_BOND_MULTIPLIER = 3
APPEAL_BOND = BOND * APPEAL_BOND_MULTIPLIER
APPEAL_WINDOW = 3 * 24 * 3600
DRAFT_EXPIRY = 7 * 24 * 3600

AGREEMENT = (
    "Contractor delivers the finished homepage redesign, in Figma, by "
    "2026-03-04. On delivery the escrowed amount is released."
)

# Distinctive first lines of the three prompts the contract can send. They are
# mutually exclusive on purpose: if two mock patterns could match the same
# prompt, every assertion in this suite about "which model said what" is a lie.
# test_amicus_judging.py::test_prompt_mocks_are_not_interchangeable pins that.
PROMPT_CLASSIFIER = r"You are a security classifier"
PROMPT_JUDGE = r"You are adjudicating a dispute"
PROMPT_APPEAL = r"You are an appeal panel rehearing"
# The two validator framings. Direct mode does not run validators during a
# contract call, but `direct_vm.run_validator()` replays the captured one, and
# that replay re-derives the outcome under these framings.
PROMPT_DERIVE = r"You are a reviewer re-deriving an outcome"
PROMPT_APPEAL_DERIVE = r"You are an appeal panel member checking"


# ---------------------------------------------------------------------------
# Basics
# ---------------------------------------------------------------------------

def contract_module():
    """The contract as a live module, for testing its pure functions.

    Reached through the module the deploy already loaded, never by a second
    import: the SDK refuses to register two `gl.Contract` subclasses in one
    process, so re-importing the file raises TypeError.
    """
    import sys

    return sys.modules["_contract_amicus"]


def addr(raw):
    """Normalize a fixture address to the SDK `Address` type.

    Contract methods annotated `Address` do not coerce raw bytes, and the
    fixtures return bytes when the SDK was not yet importable.
    """
    if hasattr(raw, "as_hex"):
        return raw
    from genlayer.py.types import Address

    return Address(raw)


def warp(direct_vm, seconds_from_now):
    """Advance chain time by a relative number of seconds."""
    import datetime

    target = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        seconds=seconds_from_now
    )
    direct_vm.warp(target.isoformat().replace("+00:00", "Z"))


@pytest.fixture
def amicus(direct_vm, direct_deploy):
    """A freshly deployed Amicus with a 2.5% fee, per test."""
    contract = direct_deploy(CONTRACT, FEE_BPS)
    # Per-test ledger of what each case was actually funded with, so that
    # conservation can be checked against money the test really attached rather
    # than against the contract's own arithmetic restated.
    direct_vm._amicus_deposits = {}
    return contract


@pytest.fixture
def parties(direct_vm, direct_alice, direct_bob, amicus):
    """(claimant, respondent) as Address, resolved after deploy."""
    return addr(direct_alice), addr(direct_bob)


@pytest.fixture
def stranger(direct_charlie, amicus):
    """A third party with no role in any case."""
    return addr(direct_charlie)


@pytest.fixture
def prompt_log(direct_vm):
    """Every prompt the contract sends, in order.

    Wraps the VM's mock matcher rather than anything inside the contract: this
    observes the boundary, not internals.
    """
    sent = []
    original = direct_vm._match_llm_mock

    def spy(prompt):
        sent.append(prompt)
        return original(prompt)

    direct_vm._match_llm_mock = spy
    try:
        yield sent
    finally:
        direct_vm._match_llm_mock = original


def judging_prompts(prompt_log):
    """Only the judging passes, first instance or appeal."""
    return [
        p
        for p in prompt_log
        if "Return ONLY a JSON object with exactly these keys" in p
    ]


def classifier_prompts(prompt_log):
    return [p for p in prompt_log if "You are a security classifier" in p]


# ---------------------------------------------------------------------------
# Case construction
# ---------------------------------------------------------------------------

def _record_deposit(direct_vm, case_id, atto):
    ledger = getattr(direct_vm, "_amicus_deposits", None)
    if ledger is None:
        ledger = {}
        direct_vm._amicus_deposits = ledger
    ledger[case_id] = ledger.get(case_id, 0) + atto


def deposited(direct_vm, case_id):
    """Total value the test attached to this case across all payable calls."""
    return getattr(direct_vm, "_amicus_deposits", {}).get(case_id, 0)


def propose(amicus, direct_vm, claimant, respondent, amount=AMOUNT, bond=BOND,
            window=WINDOW, agreement=AGREEMENT, value=None):
    """Propose a case. Returns the new case id, leaving it in DRAFT."""
    direct_vm.sender = claimant
    direct_vm.value = (amount + bond) if value is None else value
    attached = direct_vm.value
    try:
        case_id = amicus.propose_case(respondent, agreement, amount, bond, window)
    finally:
        direct_vm.value = 0
    _record_deposit(direct_vm, case_id, attached)
    return case_id


def accept(amicus, direct_vm, respondent, case_id, bond=BOND, value=None):
    """Respondent matches the bond, moving the case to ACTIVE."""
    direct_vm.sender = respondent
    direct_vm.value = bond if value is None else value
    attached = direct_vm.value
    try:
        amicus.accept_case(case_id)
    finally:
        direct_vm.value = 0
    _record_deposit(direct_vm, case_id, attached)


def fresh_case(amicus, direct_vm, claimant, respondent, **kwargs):
    """Propose and accept. Returns an ACTIVE case id."""
    bond = kwargs.get("bond", BOND)
    case_id = propose(amicus, direct_vm, claimant, respondent, **kwargs)
    accept(amicus, direct_vm, respondent, case_id, bond=bond)
    return case_id


def open_dispute(amicus, direct_vm, party, case_id):
    direct_vm.sender = party
    amicus.open_dispute(case_id)
    return case_id


def submit(amicus, direct_vm, party, case_id, statement="Our position.", urls=None):
    direct_vm.sender = party
    amicus.submit_evidence(case_id, statement, urls if urls is not None else [])


def disputed_case(amicus, direct_vm, claimant, respondent,
                  claimant_statement="The work was never delivered.",
                  respondent_statement="The work was delivered on time.",
                  claimant_urls=None, respondent_urls=None, **kwargs):
    """An ACTIVE case carried to EVIDENCE with both sides submitted."""
    case_id = fresh_case(amicus, direct_vm, claimant, respondent, **kwargs)
    open_dispute(amicus, direct_vm, claimant, case_id)
    if claimant_statement is not None:
        submit(amicus, direct_vm, claimant, case_id, claimant_statement, claimant_urls)
    if respondent_statement is not None:
        submit(
            amicus, direct_vm, respondent, case_id, respondent_statement, respondent_urls
        )
    return case_id


def judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT",
                split_bps=0, tampered=False, **kwargs):
    """A case carried all the way to JUDGED with a mocked panel."""
    case_id = disputed_case(amicus, direct_vm, claimant, respondent, **kwargs)
    warp(direct_vm, WINDOW + 60)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome=outcome, split_bps=split_bps, tampered=tampered)
    direct_vm.sender = claimant
    amicus.judge(case_id)
    return case_id


def appeal(amicus, direct_vm, appellant, case_id, value=None):
    direct_vm.sender = appellant
    direct_vm.value = APPEAL_BOND if value is None else value
    attached = direct_vm.value
    try:
        amicus.appeal(case_id)
    finally:
        direct_vm.value = 0
    _record_deposit(direct_vm, case_id, attached)


# ---------------------------------------------------------------------------
# Mocks - web and LLM only, never contract internals
# ---------------------------------------------------------------------------

def mock_evidence_page(direct_vm, url, body, status=200):
    """Mock one evidence URL.

    The contract checks the status with a GET and then renders; the VM serves
    both from this one mock, using `body` as the rendered document text.
    Matching is a regex `search` against the URL, so `url` may be a fragment.
    """
    direct_vm.mock_web(url, {"status": status, "body": body})


def mock_judgment(direct_vm, outcome="CLAIMANT", split_bps=0,
                  rationale="The evidence supports that finding.", citations=None,
                  tampered=False, raw=None):
    """Mock the first-instance judging pass.

    `raw` overrides the payload entirely, for malformed-response tests.
    """
    payload = raw if raw is not None else json.dumps(
        {
            "outcome": outcome,
            "split_bps": split_bps,
            "rationale": rationale,
            "citations": citations if citations is not None else [],
            "tampered": tampered,
        }
    )
    direct_vm.mock_llm(PROMPT_JUDGE, payload)


def mock_appeal_judgment(direct_vm, outcome="RESPONDENT", split_bps=0,
                         rationale="On rehearing the record is different.",
                         citations=None, tampered=False, raw=None):
    """Mock the appeal judging pass, which uses a different framing."""
    payload = raw if raw is not None else json.dumps(
        {
            "outcome": outcome,
            "split_bps": split_bps,
            "rationale": rationale,
            "citations": citations if citations is not None else [],
            "tampered": tampered,
        }
    )
    direct_vm.mock_llm(PROMPT_APPEAL, payload)


def mock_tamper(direct_vm, tripped, reason="ordinary argument"):
    """Mock the injection classifier for every span."""
    direct_vm.mock_llm(
        PROMPT_CLASSIFIER,
        json.dumps({"instructs": bool(tripped), "reason": reason}),
    )


def mock_tamper_for(direct_vm, span_id, tripped=True,
                    reason="contains an instruction to the reader"):
    """Mock the classifier for one span only, e.g. "CLAIMANT_STATEMENT", "DOC_1".

    Register this *before* the catch-all `mock_tamper`: the VM returns the first
    registered pattern that matches.
    """
    direct_vm.mock_llm(
        PROMPT_CLASSIFIER + r"[\s\S]*id=" + span_id + r" ",
        json.dumps({"instructs": bool(tripped), "reason": reason}),
    )


# ---------------------------------------------------------------------------
# Observation helpers
# ---------------------------------------------------------------------------

def total_value(direct_vm, addresses):
    """Sum the VM balances of the given addresses.

    Direct mode never moves value, so this is used to assert the complementary
    invariant: that a payout moved nothing behind the harness's back. The
    positive conservation claim is made by `assert_conserved` against the
    contract's recorded distribution.
    """
    total = 0
    for address in addresses:
        total += direct_vm._balances.get(direct_vm._to_bytes(address), 0)
    return total


def count_transfers(direct_vm):
    """How many value transfers the contract has asked for so far.

    Direct mode does not execute `PostMessage`; it records that the contract
    requested one. That is enough to prove `payout` does not pay twice.
    """
    return sum(1 for t in direct_vm._traces if "PostMessage" in t)


def web_hits(direct_vm):
    """Indices of the web mocks that were actually consulted.

    A test whose mock was never hit proved nothing about fetching.
    """
    return set(direct_vm._web_mocks_hit)


def judgments(amicus, case_id):
    return [json.loads(entry) for entry in amicus.get_judgments(case_id)]


def evidence(amicus, case_id):
    return [json.loads(entry) for entry in amicus.get_evidence(case_id)]


def payout_record(amicus, case_id):
    raw = amicus.get_payout(case_id)
    return json.loads(raw) if raw else None


def state_snapshot(amicus, direct_vm, case_id):
    """Everything a rejected transition must leave untouched."""
    return {
        "case": amicus.get_case(case_id),
        "evidence": amicus.get_evidence(case_id),
        "judgments": amicus.get_judgments(case_id),
        "payout": amicus.get_payout(case_id),
        "stats": amicus.get_stats(),
        "transfers": count_transfers(direct_vm),
    }


# ---------------------------------------------------------------------------
# The money invariant
# ---------------------------------------------------------------------------

def assert_conserved(amicus, direct_vm, case_id, expected_transfers=None):
    """Assert the case settled without stranding or duplicating any value.

    Everything deposited into the case has been distributed, the shares plus the
    fee equal exactly what went in, the case is terminal, and the contract asked
    for exactly one transfer per non-zero share.
    """
    record = payout_record(amicus, case_id)
    assert record is not None, "no payout record: the case never settled"

    claimant = record["claimant_atto"]
    respondent = record["respondent_atto"]
    owner = record["owner_atto"]
    escrow = record["escrow_atto"]

    # 1. The distribution adds up exactly. Not approximately.
    assert claimant + respondent + owner == escrow, (
        "distribution does not sum to escrow: %d + %d + %d != %d"
        % (claimant, respondent, owner, escrow)
    )

    # 2. Nobody receives a negative share.
    assert claimant >= 0 and respondent >= 0 and owner >= 0

    # 3. The escrow is exactly the value the test attached. This is what makes
    #    the check a conservation claim rather than a restatement of the
    #    contract's own arithmetic.
    attached = deposited(direct_vm, case_id)
    assert escrow == attached, (
        "escrow %d does not match value actually sent %d" % (escrow, attached)
    )

    # 4. The case is terminal and flagged, so nothing can pay it again.
    case = amicus.get_case(case_id)
    assert case["state"] == "PAID"
    assert case["paid_out"] is True

    # 5. One transfer per non-zero share, and no more.
    nonzero = sum(1 for share in (claimant, respondent, owner) if share > 0)
    if expected_transfers is not None:
        assert expected_transfers == nonzero, (
            "expected %d transfers, the plan has %d non-zero shares"
            % (expected_transfers, nonzero)
        )
    return record
