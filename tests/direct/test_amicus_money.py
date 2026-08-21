"""Money: conservation as an invariant, split arithmetic, fees, and bad value.

The organising idea is that conservation is not a list of cases, it is a
property. `assert_conserved` (see conftest) is run at the end of *every*
terminal path, and it checks the distribution against the value the test really
attached rather than against the contract's arithmetic restated.

Direct mode does not move value, so `_plan_payout` is also exercised directly
for the boundary arithmetic - it is a module-level pure function precisely so
that this is possible.
"""

import pytest

from conftest import (
    AMOUNT,
    APPEAL_BOND,
    APPEAL_WINDOW,
    BOND,
    CONTRACT,
    DRAFT_EXPIRY,
    FEE_BPS,
    WINDOW,
    accept,
    appeal,
    assert_conserved,
    contract_module,
    count_transfers,
    deposited,
    disputed_case,
    fresh_case,
    judged_case,
    mock_appeal_judgment,
    mock_judgment,
    mock_tamper,
    open_dispute,
    payout_record,
    propose,
    total_value,
    warp,
)

ESCROW = AMOUNT + 2 * BOND
FEE = AMOUNT * FEE_BPS // 10000


@pytest.fixture
def pure(amicus):
    return contract_module()


def settle_judged(amicus, direct_vm, case_id):
    """Wait out the appeal window and pay out."""
    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    amicus.payout(case_id)


# ---------------------------------------------------------------------------
# Conservation on every terminal path
# ---------------------------------------------------------------------------

def test_cooperative_release_conserves(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)

    direct_vm.sender = claimant
    amicus.release(case_id)
    before = count_transfers(direct_vm)
    amicus.payout(case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["escrow_atto"] == ESCROW
    assert record["respondent_atto"] == AMOUNT + BOND
    assert record["claimant_atto"] == BOND
    assert record["owner_atto"] == 0, "cooperative settlement must be free"
    assert count_transfers(direct_vm) - before == 2


def test_claimant_win_conserves(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    settle_judged(amicus, direct_vm, case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["claimant_atto"] == AMOUNT - FEE + 2 * BOND
    assert record["respondent_atto"] == 0
    assert record["owner_atto"] == FEE


def test_respondent_win_conserves(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="RESPONDENT")
    settle_judged(amicus, direct_vm, case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["respondent_atto"] == AMOUNT - FEE + 2 * BOND
    assert record["claimant_atto"] == 0
    assert record["owner_atto"] == FEE


def test_split_conserves(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(
        amicus, direct_vm, claimant, respondent, outcome="SPLIT", split_bps=6000
    )
    settle_judged(amicus, direct_vm, case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    remainder = AMOUNT - FEE
    assert record["claimant_atto"] == remainder * 6000 // 10000 + BOND
    assert record["respondent_atto"] == remainder - (remainder * 6000 // 10000) + BOND
    assert record["owner_atto"] == FEE


def test_insufficient_evidence_conserves_and_charges_nothing(
    amicus, direct_vm, parties
):
    claimant, respondent = parties
    case_id = judged_case(
        amicus, direct_vm, claimant, respondent, outcome="INSUFFICIENT_EVIDENCE"
    )
    settle_judged(amicus, direct_vm, case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["claimant_atto"] == AMOUNT + BOND
    assert record["respondent_atto"] == BOND
    assert record["owner_atto"] == 0, "nothing established means no fee"


def test_appeal_upheld_conserves(amicus, direct_vm, parties):
    """The appeal fails: the appellant forfeits the escalation bond."""
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()
    appeal(amicus, direct_vm, respondent, case_id)

    mock_tamper(direct_vm, False)
    mock_appeal_judgment(direct_vm, outcome="CLAIMANT")
    direct_vm.sender = respondent
    amicus.judge_appeal(case_id)
    amicus.payout(case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["escrow_atto"] == ESCROW + APPEAL_BOND
    assert record["claimant_atto"] == AMOUNT - FEE + 2 * BOND + APPEAL_BOND
    assert record["respondent_atto"] == 0


def test_appeal_overturned_conserves(amicus, direct_vm, parties):
    """The appeal succeeds: the appellant gets the escalation bond back."""
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()
    appeal(amicus, direct_vm, respondent, case_id)

    mock_tamper(direct_vm, False)
    mock_appeal_judgment(direct_vm, outcome="RESPONDENT")
    direct_vm.sender = respondent
    amicus.judge_appeal(case_id)
    amicus.payout(case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["escrow_atto"] == ESCROW + APPEAL_BOND
    assert record["respondent_atto"] == AMOUNT - FEE + 2 * BOND + APPEAL_BOND
    assert record["claimant_atto"] == 0


@pytest.mark.parametrize(
    "appellant_role,original_split_bps,resolved_split_bps",
    [
        ("claimant", 4000, 6500),
        ("respondent", 6000, 3500),
    ],
)
def test_favorable_split_reallocation_returns_appeal_bond(
    appellant_role,
    original_split_bps,
    resolved_split_bps,
    amicus,
    direct_vm,
    parties,
):
    """A SPLIT reallocated toward the appellant is a successful appeal."""
    claimant, respondent = parties
    appellant = claimant if appellant_role == "claimant" else respondent
    case_id = judged_case(
        amicus,
        direct_vm,
        claimant,
        respondent,
        outcome="SPLIT",
        split_bps=original_split_bps,
    )
    direct_vm.clear_mocks()
    appeal(amicus, direct_vm, appellant, case_id)

    mock_tamper(direct_vm, False)
    mock_appeal_judgment(
        direct_vm, outcome="SPLIT", split_bps=resolved_split_bps
    )
    amicus.judge_appeal(case_id)
    amicus.payout(case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    remainder = AMOUNT - FEE
    claimant_cut = remainder * resolved_split_bps // 10000
    expected_claimant = claimant_cut + BOND
    expected_respondent = remainder - claimant_cut + BOND
    if appellant_role == "claimant":
        expected_claimant += APPEAL_BOND
    else:
        expected_respondent += APPEAL_BOND

    assert record["claimant_atto"] == expected_claimant
    assert record["respondent_atto"] == expected_respondent


@pytest.mark.parametrize(
    "appellant_role,original_split_bps,resolved_split_bps",
    [
        ("claimant", 4000, 2500),
        ("respondent", 6000, 7500),
    ],
)
def test_unfavorable_split_reallocation_forfeits_appeal_bond(
    appellant_role,
    original_split_bps,
    resolved_split_bps,
    amicus,
    direct_vm,
    parties,
):
    """A SPLIT reallocated away from the appellant upholds the first result."""
    claimant, respondent = parties
    appellant = claimant if appellant_role == "claimant" else respondent
    case_id = judged_case(
        amicus,
        direct_vm,
        claimant,
        respondent,
        outcome="SPLIT",
        split_bps=original_split_bps,
    )
    direct_vm.clear_mocks()
    appeal(amicus, direct_vm, appellant, case_id)

    mock_tamper(direct_vm, False)
    mock_appeal_judgment(
        direct_vm, outcome="SPLIT", split_bps=resolved_split_bps
    )
    amicus.judge_appeal(case_id)
    amicus.payout(case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    remainder = AMOUNT - FEE
    claimant_cut = remainder * resolved_split_bps // 10000
    expected_claimant = claimant_cut + BOND
    expected_respondent = remainder - claimant_cut + BOND
    if appellant_role == "claimant":
        expected_respondent += APPEAL_BOND
    else:
        expected_claimant += APPEAL_BOND

    assert record["claimant_atto"] == expected_claimant
    assert record["respondent_atto"] == expected_respondent


def test_expired_draft_conserves(amicus, direct_vm, parties):
    """The never-accepted draft: only the claimant ever deposited."""
    claimant, respondent = parties
    case_id = propose(amicus, direct_vm, claimant, respondent)

    warp(direct_vm, DRAFT_EXPIRY + 60)
    amicus.payout(case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["escrow_atto"] == AMOUNT + BOND
    assert record["claimant_atto"] == AMOUNT + BOND
    assert record["respondent_atto"] == 0
    assert record["owner_atto"] == 0


def test_nothing_moves_behind_the_harness_back(amicus, direct_vm, parties, stranger):
    """The complementary invariant: no balance changed except through payout.

    Direct mode never credits or debits real balances, so any change here would
    mean the harness itself moved value, which would invalidate every other
    money assertion in this file.
    """
    claimant, respondent = parties
    direct_vm.deal(claimant, 10 * ESCROW)
    direct_vm.deal(respondent, 10 * ESCROW)

    watched = [claimant, respondent, stranger]
    before = total_value(direct_vm, watched)

    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    direct_vm.sender = claimant
    amicus.release(case_id)
    amicus.payout(case_id)

    assert total_value(direct_vm, watched) == before


# ---------------------------------------------------------------------------
# Split arithmetic at the boundaries
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("split_bps", [0, 1, 4999, 5000, 9999, 10000])
def test_split_boundaries_conserve_end_to_end(split_bps, amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(
        amicus, direct_vm, claimant, respondent, outcome="SPLIT", split_bps=split_bps
    )
    settle_judged(amicus, direct_vm, case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    remainder = AMOUNT - FEE
    expected_claimant = remainder * split_bps // 10000
    assert record["claimant_atto"] == expected_claimant + BOND
    assert record["respondent_atto"] == remainder - expected_claimant + BOND


def test_split_at_zero_still_returns_both_bonds(amicus, direct_vm, parties):
    """0 bps is not the same as a respondent win: bonds are not forfeited."""
    claimant, respondent = parties
    case_id = judged_case(
        amicus, direct_vm, claimant, respondent, outcome="SPLIT", split_bps=0
    )
    settle_judged(amicus, direct_vm, case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["claimant_atto"] == BOND
    assert record["respondent_atto"] == AMOUNT - FEE + BOND


def test_split_at_ten_thousand_still_returns_both_bonds(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(
        amicus, direct_vm, claimant, respondent, outcome="SPLIT", split_bps=10000
    )
    settle_judged(amicus, direct_vm, case_id)

    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["claimant_atto"] == AMOUNT - FEE + BOND
    assert record["respondent_atto"] == BOND


@pytest.mark.parametrize(
    "amount,split_bps",
    [
        (1, 5000),
        (3, 3333),
        (7, 1),
        (7, 9999),
        (999_999_999_999_999_999, 3333),
        (10**18 + 1, 6667),
        (12345, 4321),
    ],
)
def test_split_rounding_never_loses_an_atto(amount, split_bps, pure):
    """Uneven division must place the remainder deliberately, not drop it.

    Off-by-one atto is still stranded value. The contract's rule is that the
    floor goes to the claimant and the dust to the respondent, so the two shares
    re-add to exactly the post-fee amount.
    """
    result = pure._plan_payout(
        state="FINAL",
        outcome="SPLIT",
        split_bps=split_bps,
        atto_amount=amount,
        bond_atto=1,
        respondent_bonded=True,
        appeal_bond_atto=0,
        appellant="",
        original_outcome="",
        original_split_bps=0,
        fee_bps=FEE_BPS,
    )
    fee = amount * FEE_BPS // 10000
    remainder = amount - fee
    claimant_cut = remainder * split_bps // 10000

    assert result["claimant"] + result["respondent"] + result["owner"] == result["escrow"]
    assert result["escrow"] == amount + 2
    assert result["claimant"] == claimant_cut + 1
    # The dust lands on the respondent side, deliberately and only there.
    assert result["respondent"] == (remainder - claimant_cut) + 1


def test_split_dust_is_at_most_one_atto(pure):
    """Sanity-bound the rounding: the loss to flooring never exceeds one atto."""
    for amount in range(1, 200):
        for split_bps in (1, 3333, 4999, 5000, 6667, 9999):
            result = pure._plan_payout(
                state="FINAL", outcome="SPLIT", split_bps=split_bps,
                atto_amount=amount, bond_atto=0, respondent_bonded=True,
                appeal_bond_atto=0, appellant="", original_outcome="",
                original_split_bps=0,
                fee_bps=0,
            )
            assert result["claimant"] + result["respondent"] == amount
            ideal = amount * split_bps / 10000
            assert abs(result["claimant"] - ideal) < 1.0


def test_conservation_holds_across_the_whole_outcome_matrix(pure):
    """Every combination of outcome, appeal state and appellant conserves."""
    outcomes = ("CLAIMANT", "RESPONDENT", "SPLIT", "INSUFFICIENT_EVIDENCE")
    for outcome in outcomes:
        for original in outcomes:
            for appellant in ("claimant", "respondent"):
                for appeal_bond in (0, APPEAL_BOND):
                    for split_bps in (0, 1, 4321, 10000):
                        result = pure._plan_payout(
                            state="FINAL", outcome=outcome, split_bps=split_bps,
                            atto_amount=AMOUNT, bond_atto=BOND,
                            respondent_bonded=True, appeal_bond_atto=appeal_bond,
                            appellant=appellant, original_outcome=original,
                            original_split_bps=0,
                            fee_bps=FEE_BPS,
                        )
                        assert (
                            result["claimant"] + result["respondent"] + result["owner"]
                            == result["escrow"]
                        )
                        assert result["escrow"] == ESCROW + appeal_bond
                        assert min(
                            result["claimant"], result["respondent"], result["owner"]
                        ) >= 0


# ---------------------------------------------------------------------------
# Fees
# ---------------------------------------------------------------------------

def test_fee_of_zero_charges_nothing(direct_vm, direct_deploy, direct_alice, direct_bob):
    from conftest import addr

    contract = direct_deploy(CONTRACT, 0)
    direct_vm._amicus_deposits = {}
    claimant, respondent = addr(direct_alice), addr(direct_bob)

    case_id = judged_case(contract, direct_vm, claimant, respondent, outcome="CLAIMANT")
    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    contract.payout(case_id)

    record = assert_conserved(contract, direct_vm, case_id)
    assert record["owner_atto"] == 0
    assert record["claimant_atto"] == AMOUNT + 2 * BOND


def test_fee_at_the_constructor_maximum(direct_vm, direct_deploy, direct_alice, direct_bob):
    from conftest import addr

    module_max = 1000  # MAX_FEE_BPS, re-read from the module below
    contract = direct_deploy(CONTRACT, module_max)
    direct_vm._amicus_deposits = {}
    assert contract_module().MAX_FEE_BPS == module_max

    claimant, respondent = addr(direct_alice), addr(direct_bob)
    case_id = judged_case(contract, direct_vm, claimant, respondent, outcome="CLAIMANT")
    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    contract.payout(case_id)

    record = assert_conserved(contract, direct_vm, case_id)
    assert record["owner_atto"] == AMOUNT * module_max // 10000
    assert record["owner_atto"] < AMOUNT


def test_fee_above_the_maximum_is_refused_at_construction(direct_vm, direct_deploy):
    with direct_vm.expect_revert("[EXPECTED] fee_bps above maximum"):
        direct_deploy(CONTRACT, 1001)


def test_fee_is_snapshotted_per_case_and_not_mutable(amicus, direct_vm, parties):
    """There is no method that changes the fee, and each case carries its own."""
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)

    assert amicus.get_case(case_id)["fee_bps"] == FEE_BPS
    assert not [
        name for name in dir(amicus)
        if "set_fee" in name or "update_fee" in name or "fee" in name and "set" in name
    ]


def test_fee_rounds_down_and_never_exceeds_the_amount(pure):
    for fee_bps in (0, 1, 249, 250, 999, 1000):
        result = pure._plan_payout(
            state="FINAL", outcome="CLAIMANT", split_bps=0, atto_amount=AMOUNT,
            bond_atto=BOND, respondent_bonded=True, appeal_bond_atto=0,
            appellant="", original_outcome="", original_split_bps=0,
            fee_bps=fee_bps,
        )
        assert result["owner"] == AMOUNT * fee_bps // 10000
        assert result["owner"] <= AMOUNT
        assert result["claimant"] + result["respondent"] + result["owner"] == (
            result["escrow"]
        )


def test_fee_on_a_tiny_amount_rounds_to_zero_rather_than_up(pure):
    result = pure._plan_payout(
        state="FINAL", outcome="CLAIMANT", split_bps=0, atto_amount=1,
        bond_atto=0, respondent_bonded=True, appeal_bond_atto=0,
        appellant="", original_outcome="", original_split_bps=0, fee_bps=250,
    )
    assert result["owner"] == 0
    assert result["claimant"] == 1


# ---------------------------------------------------------------------------
# Double payment and premature payment
# ---------------------------------------------------------------------------

def test_payout_twice_moves_nothing_the_second_time(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    direct_vm.sender = claimant
    amicus.release(case_id)

    amicus.payout(case_id)
    first_record = amicus.get_payout(case_id)
    transfers_after_first = count_transfers(direct_vm)

    # The second and third calls are refused silently, not by reverting - and
    # crucially they emit no further transfers.
    amicus.payout(case_id)
    amicus.payout(case_id)

    assert amicus.get_payout(case_id) == first_record
    assert count_transfers(direct_vm) == transfers_after_first
    assert amicus.get_stats()["total_paid"] == 1
    assert_conserved(amicus, direct_vm, case_id)


def test_payout_twice_from_different_senders(amicus, direct_vm, parties, stranger):
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    direct_vm.sender = claimant
    amicus.release(case_id)
    amicus.payout(case_id)
    transfers = count_transfers(direct_vm)

    for who in (respondent, stranger, claimant):
        direct_vm.sender = who
        amicus.payout(case_id)
    assert count_transfers(direct_vm) == transfers


def test_payout_before_the_case_is_final_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties

    active = fresh_case(amicus, direct_vm, claimant, respondent)
    direct_vm.sender = claimant
    with direct_vm.expect_revert("cannot payout from state ACTIVE"):
        amicus.payout(active)
    assert amicus.get_payout(active) == ""
    assert count_transfers(direct_vm) == 0

    disputed = disputed_case(amicus, direct_vm, claimant, respondent)
    with direct_vm.expect_revert("cannot payout from state EVIDENCE"):
        amicus.payout(disputed)
    assert count_transfers(direct_vm) == 0


def test_payout_during_the_appeal_window_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")

    direct_vm.sender = claimant
    with direct_vm.expect_revert("[EXPECTED] appeal window is still open"):
        amicus.payout(case_id)
    assert amicus.get_payout(case_id) == ""
    assert count_transfers(direct_vm) == 0

    settle_judged(amicus, direct_vm, case_id)
    assert_conserved(amicus, direct_vm, case_id)


def test_payout_while_an_appeal_is_pending_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()
    appeal(amicus, direct_vm, respondent, case_id)

    warp(direct_vm, WINDOW + APPEAL_WINDOW + 10 * 24 * 3600)
    with direct_vm.expect_revert("cannot payout from state APPEALED"):
        amicus.payout(case_id)
    assert count_transfers(direct_vm) == 0


def test_unexpired_draft_cannot_be_paid_out(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = propose(amicus, direct_vm, claimant, respondent)

    direct_vm.sender = claimant
    with direct_vm.expect_revert("[EXPECTED] draft is still open for acceptance"):
        amicus.payout(case_id)
    assert amicus.get_state(case_id) == "DRAFT"
    assert count_transfers(direct_vm) == 0


# ---------------------------------------------------------------------------
# Bad value attached
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("delta", [-1, 1, -BOND, BOND, -AMOUNT, AMOUNT])
def test_proposing_with_the_wrong_value_is_refused(delta, amicus, direct_vm, parties):
    claimant, respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = AMOUNT + BOND + delta
    with direct_vm.expect_revert("[EXPECTED] sent value"):
        amicus.propose_case(respondent, "Deliver the thing.", AMOUNT, BOND, WINDOW)
    direct_vm.value = 0

    assert amicus.get_stats()["total_cases"] == 0


def test_proposing_with_zero_value_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = 0
    with direct_vm.expect_revert("does not match required"):
        amicus.propose_case(respondent, "Deliver the thing.", AMOUNT, BOND, WINDOW)


@pytest.mark.parametrize("delta", [-1, 1, -BOND, BOND])
def test_accepting_with_a_mismatched_bond_is_refused(delta, amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = propose(amicus, direct_vm, claimant, respondent)

    direct_vm.sender = respondent
    direct_vm.value = BOND + delta
    with direct_vm.expect_revert("does not match required bond"):
        amicus.accept_case(case_id)
    direct_vm.value = 0

    case = amicus.get_case(case_id)
    assert case["state"] == "DRAFT"
    assert case["respondent_bonded"] is False


def test_accepting_with_zero_value_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = propose(amicus, direct_vm, claimant, respondent)

    direct_vm.sender = respondent
    direct_vm.value = 0
    with direct_vm.expect_revert("does not match required bond"):
        amicus.accept_case(case_id)


def test_appealing_with_zero_value_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()

    direct_vm.sender = respondent
    direct_vm.value = 0
    with direct_vm.expect_revert("appeal requires a bond of"):
        amicus.appeal(case_id)


def test_zero_amount_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = BOND
    with direct_vm.expect_revert("[EXPECTED] atto_amount must be positive"):
        amicus.propose_case(respondent, "Deliver the thing.", 0, BOND, WINDOW)
    direct_vm.value = 0


def test_zero_bond_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = AMOUNT
    with direct_vm.expect_revert("[EXPECTED] bond_atto must be positive"):
        amicus.propose_case(respondent, "Deliver the thing.", AMOUNT, 0, WINDOW)
    direct_vm.value = 0


def test_negative_amount_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = AMOUNT + BOND
    with direct_vm.expect_revert("[EXPECTED]"):
        amicus.propose_case(respondent, "Deliver.", -AMOUNT, BOND, WINDOW)
    direct_vm.value = 0


def test_absurd_amount_is_refused(amicus, direct_vm, parties):
    """A deposit near the u256 ceiling could overflow when bonds are added."""
    module = contract_module()
    claimant, respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = module.MAX_ATTO * 2
    with direct_vm.expect_revert("[EXPECTED] amount out of range"):
        amicus.propose_case(
            respondent, "Deliver.", module.MAX_ATTO + 1, BOND, WINDOW
        )
    direct_vm.value = 0


def test_self_dealing_is_refused_at_proposal(amicus, direct_vm, parties):
    """A party cannot be both sides and pocket the fee difference."""
    claimant, _respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = AMOUNT + BOND
    with direct_vm.expect_revert("[EXPECTED] respondent cannot be the claimant"):
        amicus.propose_case(claimant, "Deliver the thing.", AMOUNT, BOND, WINDOW)
    direct_vm.value = 0

    assert amicus.get_stats()["total_cases"] == 0


def test_zero_address_respondent_is_refused(amicus, direct_vm, parties):
    """Otherwise the respondent's share would be burned rather than paid."""
    from conftest import addr

    claimant, _respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = AMOUNT + BOND
    with direct_vm.expect_revert("[EXPECTED] respondent cannot be the zero address"):
        amicus.propose_case(
            addr(bytes(20)), "Deliver the thing.", AMOUNT, BOND, WINDOW
        )
    direct_vm.value = 0


@pytest.mark.parametrize("window", [0, 1, 3599, 2592001, 10**9])
def test_out_of_range_evidence_windows_are_refused(window, amicus, direct_vm, parties):
    claimant, respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = AMOUNT + BOND
    with direct_vm.expect_revert("[EXPECTED] evidence window must be between"):
        amicus.propose_case(respondent, "Deliver.", AMOUNT, BOND, window)
    direct_vm.value = 0


def test_empty_agreement_is_refused(amicus, direct_vm, parties):
    claimant, respondent = parties
    direct_vm.sender = claimant
    direct_vm.value = AMOUNT + BOND
    for empty in ("", "   ", "\n\t "):
        with direct_vm.expect_revert("[EXPECTED] agreement text is empty"):
            amicus.propose_case(respondent, empty, AMOUNT, BOND, WINDOW)
    direct_vm.value = 0


# ---------------------------------------------------------------------------
# Preview mirrors the real thing
# ---------------------------------------------------------------------------

def test_preview_payout_matches_what_payout_actually_does(amicus, direct_vm, parties):
    """The read-only preview must not be able to disagree with the payout."""
    claimant, respondent = parties
    case_id = judged_case(
        amicus, direct_vm, claimant, respondent, outcome="SPLIT", split_bps=3700
    )
    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)

    preview = amicus.preview_payout(case_id)
    amicus.payout(case_id)
    record = payout_record(amicus, case_id)

    assert preview["claimant"] == record["claimant_atto"]
    assert preview["respondent"] == record["respondent_atto"]
    assert preview["owner"] == record["owner_atto"]
    assert preview["escrow"] == record["escrow_atto"]


def test_deposit_ledger_matches_the_contract_escrow(amicus, direct_vm, parties):
    """Sanity check on the harness itself.

    If the ledger and the contract disagreed about what was deposited, every
    conservation assertion in this file would be measuring nothing.
    """
    claimant, respondent = parties
    case_id = judged_case(amicus, direct_vm, claimant, respondent, outcome="CLAIMANT")
    direct_vm.clear_mocks()
    appeal(amicus, direct_vm, respondent, case_id)

    assert deposited(direct_vm, case_id) == ESCROW + APPEAL_BOND
    assert amicus.preview_payout(case_id)["escrow"] == ESCROW + APPEAL_BOND
