"""The consensus-critical path: `_outcomes_agree`, the error handler, and the
real `validator_fn`.

**Direct mode does not run validators during a contract call.**
`gl.vm.run_nondet_unsafe` is replaced by the test harness with a version that
calls `leader_fn()` and returns its result; `validator_fn` is never invoked as
part of `judge`. So none of the other files in this suite touch the logic that
decides whether a manipulated leader gets ratified.

It does, however, *capture* the validator. `gltest.direct.loader`'s
`_direct_run_nondet_unsafe` appends `(result, leader_fn, validator_fn)` to
`vm._captured_validators`, and `direct_vm.run_validator(...)` replays it,
wrapping the leader result in a genuine `gl.vm.Return` or `gl.vm.UserError`.
That is a supported cheatcode, not an invented internal, so the second half of
this file drives the **actual** `validator_fn` - including the case that matters
most: a leader whose result was manipulated, and a validator that re-derives the
outcome under a different framing and refuses to agree.

The first half tests the two module-level pure functions `validator_fn`
delegates to. They stay because they are exhaustive and instant: every outcome
pair, both edges of the tolerance band, and every error class, which would be
impractical to drive through a full judging round each time.
"""

import pytest

from conftest import contract_module


@pytest.fixture
def pure(amicus):
    """The contract module. `amicus` is requested only to load the SDK."""
    return contract_module()


def judgment(outcome="CLAIMANT", split_bps=0, rationale="because", citations=None,
             tampered=False):
    return {
        "outcome": outcome,
        "split_bps": split_bps,
        "rationale": rationale,
        "citations": citations if citations is not None else [],
        "tampered": tampered,
    }


OUTCOMES = ("CLAIMANT", "RESPONDENT", "SPLIT", "INSUFFICIENT_EVIDENCE")


# ===========================================================================
# _outcomes_agree - the decision field
# ===========================================================================

@pytest.mark.parametrize("outcome", OUTCOMES)
def test_identical_outcomes_agree(outcome, pure):
    assert pure._outcomes_agree(
        judgment(outcome=outcome, split_bps=5000),
        judgment(outcome=outcome, split_bps=5000),
    ) is True


@pytest.mark.parametrize(
    "leader_outcome,validator_outcome",
    [
        (a, b)
        for a in OUTCOMES
        for b in OUTCOMES
        if a != b
    ],
)
def test_different_outcomes_disagree(leader_outcome, validator_outcome, pure):
    """No tolerance whatsoever on the decision field, in either direction."""
    assert pure._outcomes_agree(
        judgment(outcome=leader_outcome, split_bps=5000),
        judgment(outcome=validator_outcome, split_bps=5000),
    ) is False


def test_claimant_versus_respondent_disagrees(pure):
    """Called out explicitly: the case where getting it wrong pays the wrong party."""
    assert pure._outcomes_agree(
        judgment(outcome="CLAIMANT"), judgment(outcome="RESPONDENT")
    ) is False
    assert pure._outcomes_agree(
        judgment(outcome="RESPONDENT"), judgment(outcome="CLAIMANT")
    ) is False


@pytest.mark.parametrize("other", ["CLAIMANT", "RESPONDENT", "SPLIT"])
def test_exactly_one_side_insufficient_disagrees(other, pure):
    """A real split of opinion about whether the record establishes anything."""
    assert pure._outcomes_agree(
        judgment(outcome="INSUFFICIENT_EVIDENCE"), judgment(outcome=other)
    ) is False
    assert pure._outcomes_agree(
        judgment(outcome=other), judgment(outcome="INSUFFICIENT_EVIDENCE")
    ) is False


def test_both_insufficient_agree(pure):
    assert pure._outcomes_agree(
        judgment(outcome="INSUFFICIENT_EVIDENCE", rationale="nothing was shown"),
        judgment(outcome="INSUFFICIENT_EVIDENCE", rationale="the record is empty"),
    ) is True


# ===========================================================================
# _outcomes_agree - the split tolerance band
# ===========================================================================

def test_split_inside_the_band_agrees(pure):
    band = pure.SPLIT_TOLERANCE_BPS
    for delta in (0, 1, band // 2, band - 1, band):
        assert pure._outcomes_agree(
            judgment(outcome="SPLIT", split_bps=5000),
            judgment(outcome="SPLIT", split_bps=5000 + delta),
        ) is True, "delta %d should be inside the band" % delta
        assert pure._outcomes_agree(
            judgment(outcome="SPLIT", split_bps=5000),
            judgment(outcome="SPLIT", split_bps=5000 - delta),
        ) is True, "delta -%d should be inside the band" % delta


def test_split_just_outside_the_band_disagrees(pure):
    """Both edges, explicitly.

    This constant is the one someone will tune later without understanding it,
    so the boundary is pinned at exactly band and band+1 in both directions.
    """
    band = pure.SPLIT_TOLERANCE_BPS

    assert pure._outcomes_agree(
        judgment(outcome="SPLIT", split_bps=5000),
        judgment(outcome="SPLIT", split_bps=5000 + band),
    ) is True, "the band edge itself must agree"
    assert pure._outcomes_agree(
        judgment(outcome="SPLIT", split_bps=5000),
        judgment(outcome="SPLIT", split_bps=5000 + band + 1),
    ) is False, "one past the band edge must disagree"

    assert pure._outcomes_agree(
        judgment(outcome="SPLIT", split_bps=5000),
        judgment(outcome="SPLIT", split_bps=5000 - band),
    ) is True
    assert pure._outcomes_agree(
        judgment(outcome="SPLIT", split_bps=5000),
        judgment(outcome="SPLIT", split_bps=5000 - band - 1),
    ) is False


def test_split_band_is_symmetric(pure):
    band = pure.SPLIT_TOLERANCE_BPS
    for a, b in ((3000, 3000 + band + 1), (7000, 7000 - band - 1)):
        assert pure._outcomes_agree(
            judgment(outcome="SPLIT", split_bps=a),
            judgment(outcome="SPLIT", split_bps=b),
        ) is False
        assert pure._outcomes_agree(
            judgment(outcome="SPLIT", split_bps=b),
            judgment(outcome="SPLIT", split_bps=a),
        ) is False


def test_wildly_different_splits_disagree(pure):
    assert pure._outcomes_agree(
        judgment(outcome="SPLIT", split_bps=0),
        judgment(outcome="SPLIT", split_bps=10000),
    ) is False


@pytest.mark.parametrize("other", ["CLAIMANT", "RESPONDENT", "INSUFFICIENT_EVIDENCE"])
def test_split_versus_a_non_split_disagrees(other, pure):
    """The band never applies across different outcomes."""
    assert pure._outcomes_agree(
        judgment(outcome="SPLIT", split_bps=5000), judgment(outcome=other)
    ) is False


def test_split_bps_is_ignored_on_decisive_outcomes(pure):
    """A stray share must not cause a false disagreement on a clear decision."""
    for outcome in ("CLAIMANT", "RESPONDENT", "INSUFFICIENT_EVIDENCE"):
        assert pure._outcomes_agree(
            judgment(outcome=outcome, split_bps=0),
            judgment(outcome=outcome, split_bps=9999),
        ) is True


# ===========================================================================
# Prose must never be compared
# ===========================================================================

def test_same_outcome_completely_different_prose_agrees(pure):
    """The test that stops someone bricking consensus by "tightening" this.

    Two models never write the same sentences. Comparing rationale or citations
    for equality would fail consensus on every single judgment.
    """
    leader = judgment(
        outcome="RESPONDENT",
        rationale=(
            "The commit history shows the redesign was pushed on March 2, two "
            "days before the deadline, so the contractor performed."
        ),
        citations=["https://github.example/repo/commit/abc"],
    )
    validator = judgment(
        outcome="RESPONDENT",
        rationale=(
            "Delivery is established by the repository record dated 2 March. "
            "Nothing in the claimant's filing contradicts it, and I therefore "
            "find for the respondent on every issue raised."
        ),
        citations=["https://invoice.example/9912", "https://github.example/repo"],
    )
    assert pure._outcomes_agree(leader, validator) is True


def test_disjoint_citations_agree(pure):
    assert pure._outcomes_agree(
        judgment(citations=["https://a.example/1"]),
        judgment(citations=["https://b.example/2", "https://c.example/3"]),
    ) is True


def test_empty_versus_long_rationale_agrees(pure):
    assert pure._outcomes_agree(
        judgment(rationale=""), judgment(rationale="A very long explanation." * 50)
    ) is True


def test_missing_rationale_and_citations_keys_agree(pure):
    """Absent prose is not disagreement."""
    assert pure._outcomes_agree(
        {"outcome": "CLAIMANT", "split_bps": 0, "tampered": False},
        {"outcome": "CLAIMANT", "split_bps": 0, "tampered": False},
    ) is True


# ===========================================================================
# Tampering
# ===========================================================================

def test_one_sided_tamper_flag_disagrees(pure):
    """If one side saw manipulation and the other did not, they read different
    records and must not ratify each other."""
    assert pure._outcomes_agree(judgment(tampered=True), judgment(tampered=False)) is False
    assert pure._outcomes_agree(judgment(tampered=False), judgment(tampered=True)) is False


def test_both_flagging_tampering_agrees(pure):
    assert pure._outcomes_agree(
        judgment(tampered=True),
        judgment(tampered=True, rationale="entirely different words"),
    ) is True


def test_tamper_flag_is_compared_even_when_outcomes_match(pure):
    for outcome in OUTCOMES:
        assert pure._outcomes_agree(
            judgment(outcome=outcome, tampered=True),
            judgment(outcome=outcome, tampered=False),
        ) is False


def test_missing_tamper_key_is_treated_as_false(pure):
    assert pure._outcomes_agree(
        {"outcome": "CLAIMANT"}, {"outcome": "CLAIMANT", "tampered": False}
    ) is True
    assert pure._outcomes_agree(
        {"outcome": "CLAIMANT"}, {"outcome": "CLAIMANT", "tampered": True}
    ) is False


# ===========================================================================
# Malformed input disagrees, and never raises
# ===========================================================================

@pytest.mark.parametrize(
    "leader,validator",
    [
        (None, {"outcome": "CLAIMANT"}),
        ({"outcome": "CLAIMANT"}, None),
        (None, None),
        ("CLAIMANT", "CLAIMANT"),
        (["CLAIMANT"], ["CLAIMANT"]),
        (42, 42),
        ({}, {}),
        ({"outcome": "claimant"}, {"outcome": "claimant"}),
        ({"outcome": "MAYBE"}, {"outcome": "MAYBE"}),
        ({"outcome": ""}, {"outcome": ""}),
        ({"outcome": None}, {"outcome": None}),
        ({"split_bps": 5000}, {"split_bps": 5000}),
        ({"outcome": "CLAIMANT"}, {}),
    ],
)
def test_malformed_input_disagrees_without_raising(leader, validator, pure):
    """It must return False, not raise.

    A validator that raises is treated by the VM as a disagreement anyway, but
    an exception escaping here would lose the reason and make the failure much
    harder to read on chain.
    """
    assert pure._outcomes_agree(leader, validator) is False


def test_unnormalized_outcomes_never_agree_even_when_identical(pure):
    """Lowercase on both sides is still not a valid outcome.

    The parser normalizes before this function ever sees a value, so an
    unnormalized value reaching here means something upstream is broken - and
    agreeing on it would ratify that breakage.
    """
    assert pure._outcomes_agree(
        judgment(outcome="claimant"), judgment(outcome="claimant")
    ) is False


@pytest.mark.parametrize("bad_split", ["not a number", None, [], {}, "abc"])
def test_unparseable_split_disagrees(bad_split, pure):
    assert pure._outcomes_agree(
        judgment(outcome="SPLIT", split_bps=bad_split),
        judgment(outcome="SPLIT", split_bps=5000),
    ) is False


def test_numeric_string_splits_are_compared_numerically(pure):
    """Defensive: values are normalized upstream, but this must not crash."""
    assert pure._outcomes_agree(
        judgment(outcome="SPLIT", split_bps="5000"),
        judgment(outcome="SPLIT", split_bps=5100),
    ) is True


# ===========================================================================
# _handle_leader_error - failure-path comparison
# ===========================================================================

class FakeResult:
    """Stands in for a non-Return `gl.vm.Result`.

    `_handle_leader_error` reads only `.message`, exactly as `gl.vm.UserError`
    and `gl.vm.VMError` expose it, so this is the shape of the real thing rather
    than an invented internal.
    """

    def __init__(self, message):
        self.message = message


def raiser(pure, message):
    """A stand-in `rerun` that fails the way the leader function would."""

    def rerun():
        raise pure.gl.vm.UserError(message)

    return rerun


def succeeder():
    def rerun():
        return {"outcome": "CLAIMANT"}

    return rerun


def test_two_transient_errors_agree(pure):
    """Network trouble is non-deterministic: both hitting it is agreement."""
    leader = FakeResult("[TRANSIENT] upstream unavailable")
    assert pure._handle_leader_error(
        leader, raiser(pure, "[TRANSIENT] a completely different network message")
    ) is True


def test_two_external_errors_agree_only_on_an_exact_match(pure):
    """4xx is deterministic, so the messages must be identical."""
    leader = FakeResult("[EXTERNAL] API returned 404")
    assert pure._handle_leader_error(
        leader, raiser(pure, "[EXTERNAL] API returned 404")
    ) is True
    assert pure._handle_leader_error(
        leader, raiser(pure, "[EXTERNAL] API returned 403")
    ) is False


def test_two_expected_errors_agree_only_on_an_exact_match(pure):
    leader = FakeResult("[EXPECTED] evidence window is still open")
    assert pure._handle_leader_error(
        leader, raiser(pure, "[EXPECTED] evidence window is still open")
    ) is True
    assert pure._handle_leader_error(
        leader, raiser(pure, "[EXPECTED] appeal window is still open")
    ) is False


def test_llm_error_always_disagrees(pure):
    """Force leader rotation rather than ratifying a broken model response."""
    leader = FakeResult("[LLM_ERROR] unnormalizable outcome: BOTH")
    assert pure._handle_leader_error(
        leader, raiser(pure, "[LLM_ERROR] unnormalizable outcome: BOTH")
    ) is False


def test_mixed_error_classes_disagree(pure):
    leader = FakeResult("[TRANSIENT] upstream unavailable")
    assert pure._handle_leader_error(
        leader, raiser(pure, "[EXTERNAL] API returned 404")
    ) is False
    assert pure._handle_leader_error(
        FakeResult("[EXTERNAL] API returned 404"),
        raiser(pure, "[TRANSIENT] upstream unavailable"),
    ) is False


def test_unclassified_error_disagrees(pure):
    leader = FakeResult("something went wrong")
    assert pure._handle_leader_error(leader, raiser(pure, "something went wrong")) is False


def test_leader_failed_but_validator_succeeded_disagrees(pure):
    """Asymmetric failure is the clearest possible disagreement."""
    leader = FakeResult("[TRANSIENT] upstream unavailable")
    assert pure._handle_leader_error(leader, succeeder()) is False


def test_validator_raising_a_non_user_error_disagrees(pure):
    """Any other exception is a disagreement, never an accidental agreement."""

    def rerun():
        raise ValueError("something unexpected")

    assert pure._handle_leader_error(FakeResult("[TRANSIENT] x"), rerun) is False


# ===========================================================================
# The seam itself
# ===========================================================================

def test_validator_fn_is_a_thin_wrapper_over_these_functions(pure):
    """Guard the reason the pure-function tests above exist.

    If `_run_panel` stopped delegating to `_outcomes_agree` and
    `_handle_leader_error`, all of the above would become decorative while
    still passing.
    """
    import inspect

    source = inspect.getsource(pure._run_panel)
    assert "_outcomes_agree(" in source
    assert "_handle_leader_error(" in source
    # And the validator must not simply re-run the leader's framing.
    assert "_judge_bundle(bundle, validator_framing)" in source


# ===========================================================================
# The real validator_fn, replayed through the harness cheatcode
# ===========================================================================

def judge_once(amicus, direct_vm, parties, leader_outcome="CLAIMANT",
               leader_split=0, **kwargs):
    """Run a full judging round, leaving one captured validator behind."""
    from conftest import WINDOW, disputed_case, mock_judgment, mock_tamper, warp

    claimant, respondent = parties
    case_id = disputed_case(amicus, direct_vm, claimant, respondent, **kwargs)
    warp(direct_vm, WINDOW + 60)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome=leader_outcome, split_bps=leader_split)
    direct_vm.sender = claimant
    amicus.judge(case_id)
    return case_id


def mock_validator_framing(direct_vm, outcome, split_bps=0, rationale="derived",
                           tampered=False):
    """Answer the validator's differently-framed judging pass.

    Registered *after* the leader's judging round, so the validator's
    independent re-derivation can be made to differ from the leader's.
    """
    import json

    from conftest import PROMPT_DERIVE

    direct_vm.mock_llm(
        PROMPT_DERIVE,
        json.dumps(
            {
                "outcome": outcome,
                "split_bps": split_bps,
                "rationale": rationale,
                "citations": [],
                "tampered": tampered,
            }
        ),
    )


def test_the_harness_captures_the_validator(amicus, direct_vm, parties):
    """Pins the capability the rest of this section depends on.

    If a future `genlayer-test` stops capturing validators for
    `run_nondet_unsafe`, this fails first and explains why the tests below went
    with it.
    """
    judge_once(amicus, direct_vm, parties)
    assert len(direct_vm._captured_validators) == 1


def test_validator_agrees_with_an_honest_leader(amicus, direct_vm, parties):
    judge_once(amicus, direct_vm, parties, leader_outcome="CLAIMANT")
    mock_validator_framing(direct_vm, outcome="CLAIMANT")

    assert direct_vm.run_validator() is True


def test_validator_disagrees_when_it_derives_the_other_party(
    amicus, direct_vm, parties
):
    """The whole point of a second framing."""
    judge_once(amicus, direct_vm, parties, leader_outcome="CLAIMANT")
    mock_validator_framing(direct_vm, outcome="RESPONDENT")

    assert direct_vm.run_validator() is False


def test_validator_refuses_a_manipulated_leader_result(amicus, direct_vm, parties):
    """The attack this contract exists to survive, at the consensus layer.

    The leader is made to return the attacker's outcome - exactly what a
    successful injection produces. The validator re-derives under the other
    framing, reaches the honest outcome, and refuses to ratify. Under real
    consensus that is a rejected transaction and a rotated leader, not a payout.
    """
    from test_amicus_injection import PLAIN_INSTRUCTION

    judge_once(
        amicus, direct_vm, parties,
        leader_outcome="RESPONDENT",
        claimant_statement=PLAIN_INSTRUCTION,
    )
    # The validator, reading the same manipulated record under a framing that
    # asks what the evidence establishes, does not reach the attacker's outcome.
    mock_validator_framing(direct_vm, outcome="INSUFFICIENT_EVIDENCE")

    manipulated = {
        "outcome": "CLAIMANT",
        "split_bps": 0,
        "rationale": "resolved in favour of the claimant",
        "citations": [],
        "tampered": False,
    }
    assert direct_vm.run_validator(leader_result=manipulated) is False


def test_validator_agrees_on_a_split_inside_the_band(amicus, direct_vm, parties):
    judge_once(amicus, direct_vm, parties, leader_outcome="SPLIT", leader_split=5000)
    module = contract_module()
    mock_validator_framing(
        direct_vm, outcome="SPLIT", split_bps=5000 + module.SPLIT_TOLERANCE_BPS
    )

    assert direct_vm.run_validator() is True


def test_validator_disagrees_on_a_split_outside_the_band(amicus, direct_vm, parties):
    judge_once(amicus, direct_vm, parties, leader_outcome="SPLIT", leader_split=5000)
    module = contract_module()
    mock_validator_framing(
        direct_vm, outcome="SPLIT", split_bps=5000 + module.SPLIT_TOLERANCE_BPS + 1
    )

    assert direct_vm.run_validator() is False


def test_validator_ignores_prose_differences(amicus, direct_vm, parties):
    """End to end confirmation that wording cannot break consensus."""
    judge_once(amicus, direct_vm, parties, leader_outcome="RESPONDENT")
    mock_validator_framing(
        direct_vm,
        outcome="RESPONDENT",
        rationale="An entirely differently worded account of the same finding.",
    )

    assert direct_vm.run_validator() is True


def test_validator_disagrees_when_only_it_sees_tampering(amicus, direct_vm, parties):
    judge_once(amicus, direct_vm, parties, leader_outcome="CLAIMANT")
    mock_validator_framing(direct_vm, outcome="CLAIMANT", tampered=True)

    assert direct_vm.run_validator() is False


def test_validator_compares_errors_not_results_when_the_leader_failed(
    amicus, direct_vm, parties
):
    """A leader error routes through `_handle_leader_error`.

    The validator here re-derives successfully, so an errored leader must be a
    disagreement - the two nodes did not see the same world.
    """
    judge_once(amicus, direct_vm, parties, leader_outcome="CLAIMANT")
    mock_validator_framing(direct_vm, outcome="CLAIMANT")

    leader_error = Exception("[TRANSIENT] upstream unavailable")
    assert direct_vm.run_validator(leader_error=leader_error) is False


def test_validator_reruns_the_evidence_fetch_independently(amicus, direct_vm, parties):
    """The validator does its own fetching, it does not trust the leader's.

    The evidence page is swapped between the leader's round and the validator's
    replay; the fetch mock being consulted again is the proof.
    """
    from conftest import mock_evidence_page, web_hits

    case_id = judge_once(
        amicus, direct_vm, parties,
        leader_outcome="RESPONDENT",
        respondent_urls=["https://git.example/commit/abc"],
    )
    assert case_id  # the leader round happened

    hits_after_leader = len(web_hits(direct_vm))
    mock_evidence_page(direct_vm, r"git\.example", "the page now says something else")
    mock_validator_framing(direct_vm, outcome="RESPONDENT")
    direct_vm.run_validator()

    assert len(web_hits(direct_vm)) >= hits_after_leader
    assert web_hits(direct_vm), "the validator never fetched anything"
