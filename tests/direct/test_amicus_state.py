"""The state machine: the transition table, access control, and deadlines.

The centrepiece is `test_transition_table_is_enforced`, which is parameterized
over every (state, method) pair and drives its expectations from the contract's
own `TRANSITIONS` constant rather than from a list written out by hand. That is
the test that catches a method added later without its guard wired up.
"""

import pytest

from conftest import (
    AMOUNT,
    APPEAL_BOND,
    APPEAL_WINDOW,
    BOND,
    DRAFT_EXPIRY,
    WINDOW,
    accept,
    addr,
    appeal,
    contract_module,
    count_transfers,
    disputed_case,
    fresh_case,
    judged_case,
    mock_appeal_judgment,
    mock_judgment,
    mock_tamper,
    open_dispute,
    propose,
    state_snapshot,
    submit,
    warp,
)

ALL_STATES = [
    "DRAFT",
    "ACTIVE",
    "RELEASED",
    "DISPUTED",
    "EVIDENCE",
    "JUDGED",
    "APPEALED",
    "FINAL",
    "PAID",
    "EXPIRED",
]

# The public methods that carry a transition. `expire_draft` is in the table but
# has no method of its own: it is reachable only through `payout` on a timed-out
# draft, which is why `payout` is special-cased below.
TRANSITION_METHODS = [
    "accept_case",
    "release",
    "open_dispute",
    "submit_evidence",
    "judge",
    "appeal",
    "judge_appeal",
    "payout",
]


def build_case_in(state, amicus, direct_vm, claimant, respondent):
    """Drive a case into `state`, or skip if that state is unreachable here."""
    if state == "DRAFT":
        return propose(amicus, direct_vm, claimant, respondent)
    if state == "ACTIVE":
        return fresh_case(amicus, direct_vm, claimant, respondent)
    if state == "RELEASED":
        case_id = fresh_case(amicus, direct_vm, claimant, respondent)
        direct_vm.sender = claimant
        amicus.release(case_id)
        return case_id
    if state == "DISPUTED":
        case_id = fresh_case(amicus, direct_vm, claimant, respondent)
        return open_dispute(amicus, direct_vm, claimant, case_id)
    if state == "EVIDENCE":
        return disputed_case(amicus, direct_vm, claimant, respondent)
    if state == "JUDGED":
        return judged_case(amicus, direct_vm, claimant, respondent)
    if state == "APPEALED":
        case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
        direct_vm.clear_mocks()
        appeal(amicus, direct_vm, respondent, case_id)
        return case_id
    if state == "FINAL":
        case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
        direct_vm.clear_mocks()
        appeal(amicus, direct_vm, respondent, case_id)
        mock_tamper(direct_vm, False)
        mock_appeal_judgment(direct_vm, outcome="RESPONDENT")
        direct_vm.sender = respondent
        amicus.judge_appeal(case_id)
        return case_id
    if state == "PAID":
        case_id = fresh_case(amicus, direct_vm, claimant, respondent)
        direct_vm.sender = claimant
        amicus.release(case_id)
        amicus.payout(case_id)
        return case_id
    if state == "EXPIRED":
        # EXPIRED is only ever transient inside a `payout` call: the contract
        # expires the draft and settles it in the same transaction, so a case can
        # never be observed resting in EXPIRED. That is a real property, pinned
        # by test_expired_is_never_observable rather than skipped.
        pytest.skip("EXPIRED is transient within payout and cannot be held")
    raise AssertionError("unknown state " + state)


def call_method(amicus, direct_vm, method, case_id, claimant, respondent):
    """Invoke `method` with arguments and a sender that are valid in themselves.

    The point is to isolate the *state* guard: the caller is always a party
    entitled to the transition, and the value attached is always correct, so a
    rejection can only be about the state.
    """
    if method == "accept_case":
        direct_vm.sender = respondent
        direct_vm.value = BOND
        try:
            amicus.accept_case(case_id)
        finally:
            direct_vm.value = 0
    elif method == "release":
        direct_vm.sender = claimant
        amicus.release(case_id)
    elif method == "open_dispute":
        direct_vm.sender = claimant
        amicus.open_dispute(case_id)
    elif method == "submit_evidence":
        direct_vm.sender = claimant
        amicus.submit_evidence(case_id, "A statement.", [])
    elif method == "judge":
        direct_vm.sender = claimant
        amicus.judge(case_id)
    elif method == "appeal":
        direct_vm.sender = respondent
        direct_vm.value = APPEAL_BOND
        try:
            amicus.appeal(case_id)
        finally:
            direct_vm.value = 0
    elif method == "judge_appeal":
        direct_vm.sender = claimant
        amicus.judge_appeal(case_id)
    elif method == "payout":
        direct_vm.sender = claimant
        amicus.payout(case_id)
    else:
        raise AssertionError("unknown method " + method)


@pytest.mark.parametrize("state", ALL_STATES)
@pytest.mark.parametrize("method", TRANSITION_METHODS)
def test_transition_table_is_enforced(state, method, amicus, direct_vm, parties):
    """Every (state, method) pair behaves exactly as TRANSITIONS says.

    Expectations come from the contract's own table. A permitted pair may still
    fail for a *different* documented reason (a deadline, an appeal window) - it
    just must not fail with the state error. A forbidden pair must fail with the
    state error, naming both the current state and the required ones.
    """
    module = contract_module()
    allowed_from, _destination = module.TRANSITIONS[method]
    allowed = set(allowed_from)

    # `payout` reaches a timed-out DRAFT through the `expire_draft` transition,
    # and is a documented no-op once PAID.
    if method == "payout":
        allowed = allowed | {"DRAFT", "PAID"}

    claimant, respondent = parties
    case_id = build_case_in(state, amicus, direct_vm, claimant, respondent)
    before = state_snapshot(amicus, direct_vm, case_id)

    expected_error = "cannot %s from state %s" % (method, state)

    if state in allowed:
        # Permitted by the table. It may still be refused for another reason,
        # but never for the state.
        try:
            call_method(amicus, direct_vm, method, case_id, claimant, respondent)
        except Exception as error:  # noqa: BLE001 - inspecting the message is the point
            assert expected_error not in str(error), (
                "%s is permitted from %s by TRANSITIONS but was refused on state: %s"
                % (method, state, error)
            )
    else:
        with direct_vm.expect_revert(expected_error):
            call_method(amicus, direct_vm, method, case_id, claimant, respondent)

        # A revert that already wrote state is the bug this suite exists for.
        after = state_snapshot(amicus, direct_vm, case_id)
        assert after == before, (
            "rejected %s from %s mutated state" % (method, state)
        )


def test_rejection_names_current_and_required_states(amicus, direct_vm, parties):
    """The error is actionable: it says where you are and where you must be."""
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)

    direct_vm.sender = claimant
    with direct_vm.expect_revert(
        "[EXPECTED] cannot judge from state ACTIVE; required one of DISPUTED/EVIDENCE"
    ):
        amicus.judge(case_id)


def test_every_rejection_is_an_expected_error(amicus, direct_vm, parties):
    """State rejections are business logic, so they must be comparable.

    `[EXPECTED]` is the prefix validators match exactly; an unclassified error
    would make validators disagree on a deterministic outcome.
    """
    claimant, respondent = parties
    case_id = propose(amicus, direct_vm, claimant, respondent)

    for method in ("release", "open_dispute", "judge", "judge_appeal"):
        direct_vm.sender = claimant
        with direct_vm.expect_revert("[EXPECTED] cannot " + method + " from state DRAFT"):
            getattr(amicus, method)(case_id)


def test_happy_path_visits_states_in_order(amicus, direct_vm, parties):
    claimant, respondent = parties
    seen = []

    case_id = propose(amicus, direct_vm, claimant, respondent)
    seen.append(amicus.get_state(case_id))

    accept(amicus, direct_vm, respondent, case_id)
    seen.append(amicus.get_state(case_id))

    open_dispute(amicus, direct_vm, claimant, case_id)
    seen.append(amicus.get_state(case_id))

    submit(amicus, direct_vm, claimant, case_id, "Ours.")
    seen.append(amicus.get_state(case_id))

    warp(direct_vm, WINDOW + 60)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="CLAIMANT")
    direct_vm.sender = claimant
    amicus.judge(case_id)
    seen.append(amicus.get_state(case_id))

    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    amicus.payout(case_id)
    seen.append(amicus.get_state(case_id))

    assert seen == ["DRAFT", "ACTIVE", "DISPUTED", "EVIDENCE", "JUDGED", "PAID"]


def test_cannot_skip_a_state(amicus, direct_vm, parties):
    """DRAFT cannot jump to DISPUTED, and ACTIVE cannot jump to JUDGED."""
    claimant, respondent = parties

    draft = propose(amicus, direct_vm, claimant, respondent)
    direct_vm.sender = claimant
    with direct_vm.expect_revert("cannot open_dispute from state DRAFT"):
        amicus.open_dispute(draft)

    active = fresh_case(amicus, direct_vm, claimant, respondent)
    direct_vm.sender = claimant
    with direct_vm.expect_revert("cannot submit_evidence from state ACTIVE"):
        amicus.submit_evidence(active, "Too early.", [])


def test_expired_is_never_observable(amicus, direct_vm, parties):
    """EXPIRED exists but no case can rest in it.

    The contract expires a timed-out draft and settles it inside the same
    `payout` call, so the refund cannot be left half-done.
    """
    claimant, respondent = parties
    case_id = propose(amicus, direct_vm, claimant, respondent)

    warp(direct_vm, DRAFT_EXPIRY + 60)
    amicus.payout(case_id)

    assert amicus.get_state(case_id) == "PAID"


# ---------------------------------------------------------------------------
# Access control
# ---------------------------------------------------------------------------

def test_only_the_respondent_can_accept(amicus, direct_vm, parties, stranger):
    claimant, respondent = parties
    case_id = propose(amicus, direct_vm, claimant, respondent)

    for who in (claimant, stranger):
        direct_vm.sender = who
        direct_vm.value = BOND
        with direct_vm.expect_revert("caller is not permitted to accept_case"):
            amicus.accept_case(case_id)
        direct_vm.value = 0

    assert amicus.get_state(case_id) == "DRAFT"
    accept(amicus, direct_vm, respondent, case_id)
    assert amicus.get_state(case_id) == "ACTIVE"


def test_only_a_party_can_release_or_dispute(amicus, direct_vm, parties, stranger):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)

    direct_vm.sender = stranger
    with direct_vm.expect_revert("caller is not permitted to release"):
        amicus.release(case_id)
    with direct_vm.expect_revert("caller is not permitted to open_dispute"):
        amicus.open_dispute(case_id)

    assert amicus.get_state(case_id) == "ACTIVE"

    # Either party can, though.
    direct_vm.sender = respondent
    amicus.open_dispute(case_id)
    assert amicus.get_state(case_id) == "DISPUTED"


def test_only_a_party_can_submit_evidence(amicus, direct_vm, parties, stranger):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)

    direct_vm.sender = stranger
    with direct_vm.expect_revert("caller is not permitted to submit_evidence"):
        amicus.submit_evidence(case_id, "I have opinions.", [])

    assert amicus.get_evidence(case_id) == []


def test_judge_is_callable_by_a_complete_stranger(amicus, direct_vm, parties, stranger):
    """Intended: nobody may strand the escrow by refusing to trigger judging."""
    claimant, respondent = parties
    case_id = disputed_case(amicus, direct_vm, claimant, respondent)
    warp(direct_vm, WINDOW + 60)

    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="RESPONDENT")

    direct_vm.sender = stranger
    assert amicus.judge(case_id) == "RESPONDENT"


def test_payout_is_callable_by_a_complete_stranger(amicus, direct_vm, parties, stranger):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    direct_vm.sender = claimant
    amicus.release(case_id)

    direct_vm.sender = stranger
    amicus.payout(case_id)
    assert amicus.get_state(case_id) == "PAID"


def test_judge_appeal_is_callable_by_a_complete_stranger(
    amicus, direct_vm, parties, stranger
):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()
    appeal(amicus, direct_vm, respondent, case_id)

    mock_tamper(direct_vm, False)
    mock_appeal_judgment(direct_vm, outcome="RESPONDENT")
    direct_vm.sender = stranger
    assert amicus.judge_appeal(case_id) == "RESPONDENT"


# ---------------------------------------------------------------------------
# Deadlines
# ---------------------------------------------------------------------------

def test_judge_before_the_deadline_is_refused_with_no_mocks_at_all(
    amicus, direct_vm, parties
):
    """Proves the gate precedes every fetch and model call.

    No web or LLM mocks are registered. If the contract reached the fetching or
    classifying stage it would raise MockNotFoundError; the fact that the
    specific business error comes back instead is the proof that no external
    work was burned on a case that is not ready.
    """
    claimant, respondent = parties
    case_id = disputed_case(
        amicus, direct_vm, claimant, respondent,
        claimant_urls=["https://evidence.example/proof"],
    )

    direct_vm.sender = claimant
    with direct_vm.expect_revert("[EXPECTED] evidence window is still open"):
        amicus.judge(case_id)

    assert amicus.get_state(case_id) == "EVIDENCE"
    assert amicus.get_judgments(case_id) == []
    assert count_transfers(direct_vm) == 0


def test_submit_evidence_after_the_deadline_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)

    warp(direct_vm, WINDOW + 60)
    direct_vm.sender = claimant
    with direct_vm.expect_revert("[EXPECTED] evidence deadline has passed"):
        amicus.submit_evidence(case_id, "Too late.", [])

    assert amicus.get_evidence(case_id) == []


def test_deadline_is_derived_from_chain_time_not_from_the_caller(
    amicus, direct_vm, parties
):
    """The window is fixed at proposal; the deadline is set when disputing."""
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)

    before = amicus.get_case(case_id)
    assert before["evidence_window_sec"] == WINDOW
    assert before["evidence_deadline"] == 0

    warp(direct_vm, 3600)
    open_dispute(amicus, direct_vm, claimant, case_id)

    after = amicus.get_case(case_id)
    assert after["evidence_deadline"] > before["created_at"] + WINDOW


def test_is_judgeable_tracks_the_gate(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    assert amicus.is_judgeable(case_id) is False

    open_dispute(amicus, direct_vm, claimant, case_id)
    assert amicus.is_judgeable(case_id) is False

    warp(direct_vm, WINDOW + 60)
    assert amicus.is_judgeable(case_id) is True


def test_draft_cannot_be_accepted_after_expiry(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = propose(amicus, direct_vm, claimant, respondent)

    warp(direct_vm, DRAFT_EXPIRY + 60)
    direct_vm.sender = respondent
    direct_vm.value = BOND
    with direct_vm.expect_revert("[EXPECTED] draft acceptance deadline has passed"):
        amicus.accept_case(case_id)
    direct_vm.value = 0

    assert amicus.get_state(case_id) == "DRAFT"


# ---------------------------------------------------------------------------
# Silence is not a veto
# ---------------------------------------------------------------------------

def test_judging_proceeds_with_evidence_from_one_side_only(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)
    submit(amicus, direct_vm, claimant, case_id, "They never delivered.")
    # The respondent simply refuses to participate.

    warp(direct_vm, WINDOW + 60)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="CLAIMANT")

    direct_vm.sender = respondent
    assert amicus.judge(case_id) == "CLAIMANT"
    assert amicus.get_state(case_id) == "JUDGED"


def test_judging_proceeds_with_no_evidence_at_all(amicus, direct_vm, parties, prompt_log):
    """Nobody filed. The case is judgeable straight out of DISPUTED.

    Pinned behaviour: the panel is told plainly that nothing was retrieved, and
    the expected finding is INSUFFICIENT_EVIDENCE, which refunds both sides.
    """
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)

    warp(direct_vm, WINDOW + 60)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="INSUFFICIENT_EVIDENCE")

    direct_vm.sender = claimant
    assert amicus.get_state(case_id) == "DISPUTED"
    assert amicus.judge(case_id) == "INSUFFICIENT_EVIDENCE"

    judging = [p for p in prompt_log if "Return ONLY a JSON object" in p]
    assert "NO EVIDENCE DOCUMENTS WERE RETRIEVED" in judging[0]
    assert "filed no statement before the deadline" in judging[0]


def test_a_party_cannot_freeze_funds_by_never_filing(amicus, direct_vm, parties):
    """The end to end version: silence settles, it does not hang."""
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)

    warp(direct_vm, WINDOW + 60)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="INSUFFICIENT_EVIDENCE")
    direct_vm.sender = claimant
    amicus.judge(case_id)

    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    amicus.payout(case_id)
    assert amicus.get_state(case_id) == "PAID"


# ---------------------------------------------------------------------------
# Evidence input validation
# ---------------------------------------------------------------------------

def test_more_urls_than_the_cap_is_refused(amicus, direct_vm, parties):
    module = contract_module()
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)

    too_many = [
        "https://example.com/%d" % i for i in range(module.MAX_URLS_PER_SUBMISSION + 1)
    ]
    direct_vm.sender = claimant
    with direct_vm.expect_revert("at most 3 urls per submission"):
        amicus.submit_evidence(case_id, "Lots of links.", too_many)

    assert amicus.get_evidence(case_id) == []


@pytest.mark.parametrize(
    "bad_url",
    [
        "http://example.com/x",
        "ftp://example.com/x",
        "javascript:alert(1)",
        "https://",
        "https://exa mple.com/x",
        "not a url at all",
        "",
        "//example.com/x",
        "HTTPS://example.com/x",
    ],
)
def test_bad_urls_are_refused(bad_url, amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)

    direct_vm.sender = claimant
    with direct_vm.expect_revert("evidence urls must be https and well formed"):
        amicus.submit_evidence(case_id, "See link.", [bad_url])


def test_url_over_the_length_cap_is_refused(amicus, direct_vm, parties):
    module = contract_module()
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)

    long_url = "https://example.com/" + "a" * module.MAX_URL_CHARS
    direct_vm.sender = claimant
    with direct_vm.expect_revert("evidence urls must be https and well formed"):
        amicus.submit_evidence(case_id, "See link.", [long_url])


def test_statement_over_the_cap_is_refused(amicus, direct_vm, parties):
    module = contract_module()
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)

    direct_vm.sender = claimant
    with direct_vm.expect_revert("statement exceeds 4000 characters"):
        amicus.submit_evidence(case_id, "x" * (module.MAX_STATEMENT_CHARS + 1), [])


def test_one_submission_per_party(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)

    submit(amicus, direct_vm, claimant, case_id, "First filing.")
    direct_vm.sender = claimant
    with direct_vm.expect_revert("already filed its submission"):
        amicus.submit_evidence(case_id, "Second filing.", [])

    submit(amicus, direct_vm, respondent, case_id, "Our answer.")
    assert len(amicus.get_evidence(case_id)) == 2


# ---------------------------------------------------------------------------
# Appeal: one level, one window, one bond
# ---------------------------------------------------------------------------

def test_the_winner_cannot_appeal(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()

    direct_vm.sender = claimant
    direct_vm.value = APPEAL_BOND
    with direct_vm.expect_revert("caller is not permitted to appeal"):
        amicus.appeal(case_id)
    direct_vm.value = 0

    assert amicus.get_state(case_id) == "JUDGED"


def test_a_stranger_cannot_appeal(amicus, direct_vm, parties, stranger):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()

    direct_vm.sender = stranger
    direct_vm.value = APPEAL_BOND
    with direct_vm.expect_revert("caller is not permitted to appeal"):
        amicus.appeal(case_id)
    direct_vm.value = 0


def test_the_loser_can_appeal_inside_the_window(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()

    appeal(amicus, direct_vm, respondent, case_id)
    case = amicus.get_case(case_id)
    assert case["state"] == "APPEALED"
    assert case["appellant"] == "respondent"
    assert case["appeal_bond_atto"] == APPEAL_BOND


@pytest.mark.parametrize("outcome", ["SPLIT", "INSUFFICIENT_EVIDENCE"])
def test_either_party_may_appeal_an_indecisive_outcome(
    outcome, amicus, direct_vm, parties
):
    claimant, respondent = parties
    case_id = judged_case(
        amicus, direct_vm, claimant, respondent, outcome=outcome, split_bps=5000
    )
    direct_vm.clear_mocks()

    appeal(amicus, direct_vm, claimant, case_id)
    assert amicus.get_case(case_id)["appellant"] == "claimant"


def test_appeal_after_the_window_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()

    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    direct_vm.sender = respondent
    direct_vm.value = APPEAL_BOND
    with direct_vm.expect_revert("[EXPECTED] appeal window has closed"):
        amicus.appeal(case_id)
    direct_vm.value = 0

    assert amicus.get_state(case_id) == "JUDGED"


def test_appealing_twice_is_refused(amicus, direct_vm, parties):
    """One level means one, enforced by the state machine and by the flag."""
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()
    appeal(amicus, direct_vm, respondent, case_id)

    direct_vm.sender = claimant
    direct_vm.value = APPEAL_BOND
    with direct_vm.expect_revert("cannot appeal from state APPEALED"):
        amicus.appeal(case_id)
    direct_vm.value = 0

    # And once rejudged, FINAL is not appealable either.
    mock_tamper(direct_vm, False)
    mock_appeal_judgment(direct_vm, outcome="RESPONDENT")
    direct_vm.sender = respondent
    amicus.judge_appeal(case_id)

    direct_vm.sender = claimant
    direct_vm.value = APPEAL_BOND
    with direct_vm.expect_revert("cannot appeal from state FINAL"):
        amicus.appeal(case_id)
    direct_vm.value = 0


@pytest.mark.parametrize("wrong_bond_factor", [0, 1, 2, 4])
def test_appeal_bond_must_be_exactly_the_multiple(
    wrong_bond_factor, amicus, direct_vm, parties
):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()

    direct_vm.sender = respondent
    direct_vm.value = BOND * wrong_bond_factor
    with direct_vm.expect_revert("[EXPECTED] appeal requires a bond of"):
        amicus.appeal(case_id)
    direct_vm.value = 0

    assert amicus.get_state(case_id) == "JUDGED"


def test_appeal_bond_one_atto_short_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()

    direct_vm.sender = respondent
    direct_vm.value = APPEAL_BOND - 1
    with direct_vm.expect_revert("appeal requires a bond of"):
        amicus.appeal(case_id)
    direct_vm.value = 0


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

def test_unknown_case_is_an_expected_error(amicus, direct_vm, parties):
    claimant, _respondent = parties
    direct_vm.sender = claimant
    with direct_vm.expect_revert("[EXPECTED] unknown case"):
        amicus.get_state("case-does-not-exist")


def test_list_cases_is_paginated_and_hard_capped(amicus, direct_vm, parties):
    module = contract_module()
    claimant, respondent = parties
    for _ in range(3):
        propose(amicus, direct_vm, claimant, respondent)

    assert amicus.list_cases(0, 2) == ["case-1", "case-2"]
    assert amicus.list_cases(2, 10) == ["case-3"]
    assert amicus.list_cases(9, 10) == []
    assert amicus.list_cases(0, 0) == []
    # The cap applies even when a caller asks for more.
    assert len(amicus.list_cases(0, module.MAX_PAGE_LIMIT * 100)) == 3


def test_stats_track_cases_disputes_and_payouts(amicus, direct_vm, parties):
    claimant, respondent = parties
    assert amicus.get_stats()["total_cases"] == 0

    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    assert amicus.get_stats()["total_cases"] == 1
    assert amicus.get_stats()["total_disputes"] == 0

    open_dispute(amicus, direct_vm, claimant, case_id)
    assert amicus.get_stats()["total_disputes"] == 1

    second = fresh_case(amicus, direct_vm, claimant, respondent)
    direct_vm.sender = claimant
    amicus.release(second)
    amicus.payout(second)
    assert amicus.get_stats()["total_paid"] == 1
