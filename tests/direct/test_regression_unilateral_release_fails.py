"""Regression: the respondent cannot unilaterally release the claimant's funds.

Steward finding. `release()` moves the disputed amount to the *respondent* (see
_plan_payout, STATE_RELEASED). While ACTORS["release"] was "either_party" the
respondent could call release() on an ACTIVE case and pay the claimant's
escrowed amount to itself - no claimant consent, no dispute, no panel. That is a
theft of escrow dressed up as a cooperative settlement.

The fix makes release claimant-only. These tests pin the property from the
attacker's side: every way the respondent might try to reach the claimant's
funds without authorization must revert cleanly and move nothing, while the two
legitimate paths - an explicit claimant release, and a formal adjudication - keep
working.
"""

from conftest import (
    AMOUNT,
    APPEAL_WINDOW,
    BOND,
    FEE_BPS,
    WINDOW,
    contract_module,
    count_transfers,
    deposited,
    fresh_case,
    mock_judgment,
    mock_tamper,
    open_dispute,
    payout_record,
    submit,
    warp,
)

ESCROW = AMOUNT + 2 * BOND
FEE = AMOUNT * FEE_BPS // 10000


def test_respondent_cannot_unilaterally_release_to_itself(amicus, direct_vm, parties):
    """The core attack: respondent calls release() to grab the claimant's amount.

    It must revert with the authorization error, leave the case ACTIVE, and emit
    no transfer whatsoever.
    """
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    assert amicus.get_state(case_id) == "ACTIVE"

    direct_vm.sender = respondent
    with direct_vm.expect_revert("caller is not permitted to release"):
        amicus.release(case_id)

    # Nothing moved and nothing changed: the escrow is untouched and no payout
    # record was ever written.
    assert amicus.get_state(case_id) == "ACTIVE"
    assert count_transfers(direct_vm) == 0
    assert amicus.get_payout(case_id) == ""
    assert deposited(direct_vm, case_id) == ESCROW


def test_release_is_claimant_only_in_the_authorization_table(amicus):
    """Pin the fix at its source: release is authorized to the claimant alone.

    ACTORS is the whole authorization model; a future edit back to "either_party"
    or "respondent" would reopen the hole and must fail here. The `amicus` fixture
    is required so the contract module is loaded before it is inspected.
    """
    module = contract_module()
    assert module.ACTORS["release"] == "claimant"


def test_respondent_cannot_reach_the_funds_via_payout_either(amicus, direct_vm, parties):
    """The bypass has no second door: payout() on an ACTIVE case also reverts.

    Even having failed to release, the respondent cannot call payout to force a
    distribution - ACTIVE is not a payable state.
    """
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)

    direct_vm.sender = respondent
    with direct_vm.expect_revert("cannot payout from state ACTIVE"):
        amicus.payout(case_id)

    assert amicus.get_state(case_id) == "ACTIVE"
    assert count_transfers(direct_vm) == 0


def test_respondent_cannot_release_after_opening_a_dispute(amicus, direct_vm, parties):
    """Once disputed, the escrow moves only by adjudication - never by release.

    A respondent who opened a dispute (a state where release is not even a legal
    transition) must not be able to fall back to release() to self-pay.
    """
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, respondent, case_id)
    assert amicus.get_state(case_id) == "DISPUTED"

    direct_vm.sender = respondent
    # Blocked on both the actor guard and the state guard; either revert proves
    # the funds stay put. The state guard fires first.
    with direct_vm.expect_revert("cannot release from state DISPUTED"):
        amicus.release(case_id)

    assert amicus.get_state(case_id) == "DISPUTED"
    assert count_transfers(direct_vm) == 0


def test_claimant_release_still_settles_normally(amicus, direct_vm, parties):
    """The legitimate path is intact: the claimant may still release cooperatively.

    Fixing the hole must not break consensual settlement. When the *claimant*
    authorizes it, the amount and bond go to the respondent exactly as before.
    """
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)

    direct_vm.sender = claimant
    amicus.release(case_id)
    amicus.payout(case_id)

    record = payout_record(amicus, case_id)
    assert amicus.get_state(case_id) == "PAID"
    assert record["respondent_atto"] == AMOUNT + BOND
    assert record["claimant_atto"] == BOND
    assert record["owner_atto"] == 0


def test_respondent_still_wins_the_amount_only_through_adjudication(
    amicus, direct_vm, parties
):
    """The one honest way funds flow to the respondent: a panel rules for it.

    This is the control for the whole fix - the respondent is not barred from the
    amount, only from taking it without authority. A RESPONDENT judgment pays it
    over, proving the block is on the bypass and not on the outcome.
    """
    claimant, respondent = parties
    case_id = fresh_case(amicus, direct_vm, claimant, respondent)
    open_dispute(amicus, direct_vm, claimant, case_id)
    submit(amicus, direct_vm, claimant, case_id, "Not delivered.")
    submit(amicus, direct_vm, respondent, case_id, "Delivered on time.")

    warp(direct_vm, WINDOW + 60)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="RESPONDENT")
    direct_vm.sender = respondent
    assert amicus.judge(case_id) == "RESPONDENT"

    warp(direct_vm, APPEAL_WINDOW + 120)
    amicus.payout(case_id)

    record = payout_record(amicus, case_id)
    assert record["respondent_atto"] == AMOUNT - FEE + 2 * BOND
    assert record["claimant_atto"] == 0
