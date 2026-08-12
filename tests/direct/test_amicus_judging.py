"""Judging: outcomes, evidence fetching, and defensive parsing.

Every parsing test goes through the public `judge` path rather than poking the
helper directly, because the property that matters is not "the parser raised" -
it is that a malformed model response leaves **no judgment recorded and no value
moved**. A contract that writes a garbage judgment and then raises is worse than
one that just raises.
"""

import json
import re

import pytest

from conftest import (
    AMOUNT,
    APPEAL_WINDOW,
    BOND,
    FEE_BPS,
    WINDOW,
    assert_conserved,
    contract_module,
    count_transfers,
    disputed_case,
    fresh_case,
    judging_prompts,
    mock_evidence_page,
    mock_judgment,
    mock_tamper,
    open_dispute,
    payout_record,
    submit,
    warp,
    web_hits,
)

GOOD_URL = "https://git.example/commit/abc123"
GOOD_PAGE = "commit abc123 merged 2026-03-02, homepage-redesign.fig attached"
OTHER_URL = "https://invoice.example/9912"
OTHER_PAGE = "Invoice 9912, homepage redesign, paid in full on 2026-03-05"


def ready_to_judge(amicus, direct_vm, claimant, respondent, **kwargs):
    case_id = disputed_case(amicus, direct_vm, claimant, respondent, **kwargs)
    warp(direct_vm, WINDOW + 60)
    return case_id


# ---------------------------------------------------------------------------
# The mocks must be distinguishable, or nothing else here means anything
# ---------------------------------------------------------------------------

def test_prompt_mocks_are_not_interchangeable(amicus, direct_vm, parties, prompt_log):
    """Deliberately conflicting mocks: assert each stage used its own.

    The classifier, the first-instance judge and the appeal panel each get an
    answer that would be wrong for the other two. If any pattern could match a
    prompt it was not meant for, this test fails and every other assertion in
    this file about "what the judge said" is unreliable.
    """
    from conftest import PROMPT_APPEAL, PROMPT_CLASSIFIER, PROMPT_JUDGE, appeal

    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)

    # Three distinct payloads. The classifier's shape is not a judgment, and
    # the two judgments disagree with each other.
    direct_vm.mock_llm(PROMPT_CLASSIFIER, json.dumps({"instructs": False, "reason": "ok"}))
    direct_vm.mock_llm(
        PROMPT_JUDGE,
        json.dumps({"outcome": "CLAIMANT", "split_bps": 0, "rationale": "first",
                    "citations": [], "tampered": False}),
    )
    direct_vm.mock_llm(
        PROMPT_APPEAL,
        json.dumps({"outcome": "RESPONDENT", "split_bps": 0, "rationale": "second",
                    "citations": [], "tampered": False}),
    )

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == "CLAIMANT", "first instance used the wrong mock"

    appeal(amicus, direct_vm, respondent, case_id)
    direct_vm.sender = respondent
    assert amicus.judge_appeal(case_id) == "RESPONDENT", "appeal used the wrong mock"

    # Each prompt matched exactly one pattern, and the two judging prompts are
    # genuinely different strings.
    judging = judging_prompts(prompt_log)
    assert len(judging) == 2
    assert judging[0] != judging[1]
    assert "You are adjudicating a dispute" in judging[0]
    assert "You are an appeal panel rehearing" in judging[1]
    assert "You are an appeal panel rehearing" not in judging[0]

    records = [json.loads(entry) for entry in amicus.get_judgments(case_id)]
    assert [r["stage"] for r in records] == ["judgment", "appeal"]
    assert [r["outcome"] for r in records] == ["CLAIMANT", "RESPONDENT"]
    assert [r["rationale"] for r in records] == ["first", "second"]


def test_classifier_runs_once_per_untrusted_span(amicus, direct_vm, parties, prompt_log):
    """Agreement, both statements, and each fetched document."""
    from conftest import classifier_prompts

    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent,
        claimant_urls=[GOOD_URL], respondent_urls=[OTHER_URL],
    )
    mock_evidence_page(direct_vm, r"git\.example", GOOD_PAGE)
    mock_evidence_page(direct_vm, r"invoice\.example", OTHER_PAGE)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="SPLIT", split_bps=5000)

    direct_vm.sender = claimant
    amicus.judge(case_id)

    spans = classifier_prompts(prompt_log)
    ids = sorted(p.split("id=")[1].split(" ")[0] for p in spans)
    assert ids == [
        "AGREEMENT", "CLAIMANT_STATEMENT", "DOC_1", "DOC_2", "RESPONDENT_STATEMENT"
    ]


# ---------------------------------------------------------------------------
# One test per outcome
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "outcome,split_bps",
    [
        ("CLAIMANT", 0),
        ("RESPONDENT", 0),
        ("SPLIT", 4500),
        ("INSUFFICIENT_EVIDENCE", 0),
    ],
)
def test_outcome_is_recorded_and_paid(outcome, split_bps, amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent, claimant_urls=[GOOD_URL]
    )
    mock_evidence_page(direct_vm, r"git\.example", GOOD_PAGE)
    mock_tamper(direct_vm, False)
    mock_judgment(
        direct_vm, outcome=outcome, split_bps=split_bps,
        rationale="A specific reason grounded in the record.",
        citations=[GOOD_URL],
    )

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == outcome

    case = amicus.get_case(case_id)
    assert case["state"] == "JUDGED"
    assert case["outcome"] == outcome
    assert case["split_bps"] == (split_bps if outcome == "SPLIT" else 0)

    records = [json.loads(e) for e in amicus.get_judgments(case_id)]
    assert len(records) == 1
    record = records[0]
    assert record["stage"] == "judgment"
    assert record["outcome"] == outcome
    assert record["rationale"] == "A specific reason grounded in the record."
    assert record["citations"] == [GOOD_URL]
    assert record["timestamp"] > 0

    # Per-URL reachability is on the record, not just the text.
    assert len(record["fetches"]) == 1
    fetch = record["fetches"][0]
    assert fetch["url"] == GOOD_URL
    assert fetch["status"] == "OK"
    assert fetch["side"] == "claimant"
    assert fetch["chars"] == len(GOOD_PAGE)

    # And the fetch really happened.
    assert web_hits(direct_vm), "the evidence mock was never consulted"

    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    amicus.payout(case_id)
    assert_conserved(amicus, direct_vm, case_id)


def test_judgment_record_is_append_only(amicus, direct_vm, parties):
    """Nothing deletes or edits a judgment - there is no method that can."""
    from conftest import appeal, mock_appeal_judgment

    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="CLAIMANT", rationale="first pass")
    direct_vm.sender = claimant
    amicus.judge(case_id)

    first = amicus.get_judgments(case_id)
    appeal(amicus, direct_vm, respondent, case_id)
    mock_appeal_judgment(direct_vm, outcome="RESPONDENT", rationale="second pass")
    direct_vm.sender = respondent
    amicus.judge_appeal(case_id)

    both = amicus.get_judgments(case_id)
    assert len(both) == 2
    assert both[0] == first[0], "the first judgment was rewritten"
    assert amicus.get_case(case_id)["original_outcome"] == "CLAIMANT"
    assert amicus.get_case(case_id)["outcome"] == "RESPONDENT"
    assert amicus.get_case(case_id)["judgment_count"] == 2


def test_judgments_pagination_is_capped(amicus, direct_vm, parties):
    module = contract_module()
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="CLAIMANT")
    direct_vm.sender = claimant
    amicus.judge(case_id)

    assert len(amicus.get_judgments_page(case_id, 0, module.MAX_PAGE_LIMIT * 100)) == 1
    assert amicus.get_judgments_page(case_id, 5, 10) == []
    assert amicus.get_judgments_page(case_id, 0, 0) == []


# ---------------------------------------------------------------------------
# Evidence fetching
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "status,error_class",
    [(404, "[EXTERNAL]"), (410, "[EXTERNAL]"), (500, "[TRANSIENT]"), (503, "[TRANSIENT]")],
)
def test_unreachable_url_is_recorded_and_the_case_still_settles(
    status, error_class, amicus, direct_vm, parties
):
    """A dead link must not stall a dispute, nor benefit whoever cited it."""
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent, claimant_urls=["https://gone.example/x"]
    )
    mock_evidence_page(direct_vm, r"gone\.example", "Not Found", status=status)
    mock_tamper(direct_vm, False)
    # The judge is told the link could not be verified, and finds accordingly.
    mock_judgment(direct_vm, outcome="INSUFFICIENT_EVIDENCE")

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == "INSUFFICIENT_EVIDENCE"

    record = json.loads(amicus.get_judgments(case_id)[0])
    fetch = record["fetches"][0]
    assert fetch["status"] == "UNREACHABLE"
    assert fetch["error_class"] == error_class
    assert fetch["detail"] == "http %d" % status
    assert fetch["chars"] == 0

    # The citing party gains nothing: the outcome is not automatically theirs.
    assert record["outcome"] != "CLAIMANT"

    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    amicus.payout(case_id)
    assert_conserved(amicus, direct_vm, case_id)


def test_unreachable_page_content_never_reaches_the_prompt(
    amicus, direct_vm, parties, prompt_log
):
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent, claimant_urls=["https://gone.example/x"]
    )
    mock_evidence_page(
        direct_vm, r"gone\.example", "SECRET BODY TEXT that 404 pages sometimes carry",
        status=404,
    )
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="INSUFFICIENT_EVIDENCE")
    direct_vm.sender = claimant
    amicus.judge(case_id)

    prompt = judging_prompts(prompt_log)[0]
    assert "SECRET BODY TEXT" not in prompt
    assert "UNREACHABLE" in prompt
    assert "establishing nothing at all" in prompt


def test_network_failure_is_transient_not_fatal(amicus, direct_vm, parties):
    """An unmockable host stands in for one that simply does not answer.

    Note this is the one place an unmocked URL is intentional: the contract
    catches the fetch failure and records it, so the case proceeds.
    """
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent, claimant_urls=["https://void.example/x"]
    )
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="INSUFFICIENT_EVIDENCE")

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == "INSUFFICIENT_EVIDENCE"

    fetch = json.loads(amicus.get_judgments(case_id)[0])["fetches"][0]
    assert fetch["status"] == "UNREACHABLE"
    assert fetch["error_class"] == "[TRANSIENT]"


def test_one_party_all_dead_links_the_other_resolving(amicus, direct_vm, parties):
    """Asymmetric reachability must not decide the case by itself."""
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent,
        claimant_urls=["https://gone.example/a", "https://gone.example/b"],
        respondent_urls=[GOOD_URL],
    )
    mock_evidence_page(direct_vm, r"gone\.example", "nope", status=404)
    mock_evidence_page(direct_vm, r"git\.example", GOOD_PAGE)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="RESPONDENT", citations=[GOOD_URL])

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == "RESPONDENT"

    record = json.loads(amicus.get_judgments(case_id)[0])
    by_status = {}
    for fetch in record["fetches"]:
        by_status.setdefault(fetch["status"], []).append(fetch["side"])
    assert sorted(by_status["UNREACHABLE"]) == ["claimant", "claimant"]
    assert by_status["OK"] == ["respondent"]
    assert record["citations"] == [GOOD_URL]


def test_document_over_the_cap_is_truncated_before_the_prompt(
    amicus, direct_vm, parties, prompt_log
):
    module = contract_module()
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent, claimant_urls=[GOOD_URL]
    )
    huge = "L" * (module.MAX_DOC_CHARS * 4)
    mock_evidence_page(direct_vm, r"git\.example", huge)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="INSUFFICIENT_EVIDENCE")

    direct_vm.sender = claimant
    amicus.judge(case_id)

    fetch = json.loads(amicus.get_judgments(case_id)[0])["fetches"][0]
    assert fetch["chars"] <= module.MAX_DOC_CHARS

    prompt = judging_prompts(prompt_log)[0]
    # Measure the document itself, not every "L" in the prompt - the template
    # text contains some of its own (UNREACHABLE, EXCLUDED, and so on).
    longest_run = max(len(match.group(0)) for match in re.finditer(r"L+", prompt))
    assert longest_run <= module.MAX_DOC_CHARS
    assert len(huge) > longest_run, "the document was not truncated at all"
    assert "[TRUNCATED]" in prompt


def test_total_document_budget_is_enforced_across_all_urls(amicus, direct_vm, parties):
    module = contract_module()
    claimant, respondent = parties
    claimant_urls = ["https://big%d.example/doc" % i for i in range(3)]
    respondent_urls = ["https://huge%d.example/doc" % i for i in range(3)]
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent,
        claimant_urls=claimant_urls, respondent_urls=respondent_urls,
    )
    mock_evidence_page(direct_vm, r"(big|huge)\d\.example", "L" * 50_000)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="SPLIT", split_bps=5000)

    direct_vm.sender = claimant
    amicus.judge(case_id)

    fetches = json.loads(amicus.get_judgments(case_id)[0])["fetches"]
    assert len(fetches) == 6
    total = sum(f["chars"] for f in fetches)
    assert total <= module.MAX_TOTAL_DOC_CHARS
    for fetch in fetches:
        assert fetch["chars"] <= module.MAX_DOC_CHARS


def test_urls_are_interleaved_so_a_budget_squeeze_is_even(amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent,
        claimant_urls=["https://c%d.example/x" % i for i in range(3)],
        respondent_urls=["https://r%d.example/x" % i for i in range(3)],
    )
    mock_evidence_page(direct_vm, r"[cr]\d\.example", "short page")
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="SPLIT", split_bps=5000)

    direct_vm.sender = claimant
    amicus.judge(case_id)

    sides = [f["side"] for f in json.loads(amicus.get_judgments(case_id)[0])["fetches"]]
    assert sides == [
        "claimant", "respondent", "claimant", "respondent", "claimant", "respondent"
    ]


def test_fetched_content_actually_reaches_the_judge(amicus, direct_vm, parties, prompt_log):
    """The whole premise: the judge reads the source, not a summary of it."""
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent, respondent_urls=[GOOD_URL]
    )
    mock_evidence_page(direct_vm, r"git\.example", GOOD_PAGE)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="RESPONDENT", citations=[GOOD_URL])

    direct_vm.sender = claimant
    amicus.judge(case_id)

    prompt = judging_prompts(prompt_log)[0]
    assert GOOD_PAGE in prompt
    assert web_hits(direct_vm) == {0}, "the evidence mock was never consulted"


# ---------------------------------------------------------------------------
# Defensive parsing - through the public path
# ---------------------------------------------------------------------------

def assert_nothing_recorded(amicus, direct_vm, case_id):
    """After a rejected judgment: no record, no state change, no value moved."""
    assert amicus.get_judgments(case_id) == []
    case = amicus.get_case(case_id)
    assert case["state"] == "EVIDENCE"
    assert case["outcome"] == ""
    assert case["split_bps"] == 0
    assert case["paid_out"] is False
    assert amicus.get_payout(case_id) == ""
    assert count_transfers(direct_vm) == 0


@pytest.mark.parametrize(
    "raw_outcome,expected",
    [
        ("claimant", "CLAIMANT"),
        ("  CLAIMANT  ", "CLAIMANT"),
        ("For Claimant", "CLAIMANT"),
        ("for-claimant", "CLAIMANT"),
        ("respondent_wins", "RESPONDENT"),
        ("partial", "SPLIT"),
        ("insufficient evidence", "INSUFFICIENT_EVIDENCE"),
        ("undetermined", "INSUFFICIENT_EVIDENCE"),
    ],
)
def test_outcome_variants_normalize(raw_outcome, expected, amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(
        direct_vm,
        raw=json.dumps({"outcome": raw_outcome, "rationale": "r", "citations": []}),
    )

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == expected


@pytest.mark.parametrize(
    "key", ["outcome", "decision", "verdict", "ruling", "result"]
)
def test_aliased_outcome_keys_are_accepted(key, amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, raw=json.dumps({key: "CLAIMANT", "rationale": "r"}))

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == "CLAIMANT"


@pytest.mark.parametrize(
    "payload",
    [
        json.dumps({"outcome": "BOTH", "rationale": "r"}),
        json.dumps({"outcome": "probably the claimant", "rationale": "r"}),
        json.dumps({"outcome": "", "rationale": "r"}),
        json.dumps({"outcome": "NOBODY", "rationale": "r"}),
        json.dumps({"rationale": "no outcome at all"}),
        json.dumps({"outcome": None, "rationale": "r"}),
        json.dumps(["CLAIMANT"]),
        json.dumps("CLAIMANT"),
        json.dumps(42),
    ],
)
def test_malformed_judgment_records_nothing_and_moves_nothing(
    payload, amicus, direct_vm, parties
):
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, raw=payload)

    direct_vm.sender = claimant
    with direct_vm.expect_revert("[LLM_ERROR]"):
        amicus.judge(case_id)

    assert_nothing_recorded(amicus, direct_vm, case_id)


@pytest.mark.parametrize(
    "raw_split,expected",
    [
        (5000, 5000),
        ("5000", 5000),
        ("5000.4", 5000),
        ("5000.6", 5001),
        ("60%", 6000),
        (-1, 0),
        (-99999, 0),
        (10001, 10000),
        (99999999, 10000),
        (None, 0),
        ("", 0),
    ],
)
def test_split_bps_is_coerced_and_clamped(raw_split, expected, amicus, direct_vm, parties):
    """Pinned behaviour: out-of-range clamps, unparseable rejects.

    Note the decimal cases are *strings*. A JSON float cannot be exercised
    through this path at all - see
    test_a_json_float_cannot_cross_the_calldata_boundary.
    """
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(
        direct_vm,
        raw=json.dumps({"outcome": "SPLIT", "split_bps": raw_split, "rationale": "r"}),
    )

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == "SPLIT"
    assert amicus.get_case(case_id)["split_bps"] == expected


def test_split_with_split_bps_missing_entirely(amicus, direct_vm, parties):
    """Pinned: a SPLIT with no share defaults to 0, i.e. all to the respondent.

    That is a real decision, not an accident - the claimant asserting a share
    without quantifying it gets nothing of the amount, but keeps their bond.
    """
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, raw=json.dumps({"outcome": "SPLIT", "rationale": "r"}))

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == "SPLIT"
    assert amicus.get_case(case_id)["split_bps"] == 0

    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    amicus.payout(case_id)
    record = assert_conserved(amicus, direct_vm, case_id)
    fee = AMOUNT * FEE_BPS // 10000
    assert record["claimant_atto"] == BOND
    assert record["respondent_atto"] == AMOUNT - fee + BOND


@pytest.mark.parametrize("raw_float", [5000.4, 5000.6, 0.5])
def test_a_json_float_cannot_cross_the_calldata_boundary(raw_float, amicus, direct_vm):
    """GenLayer calldata has no float type, so a float cannot reach the parser.

    `_normalize_split_bps` handles floats, which implies the author expected a
    model to return `"split_bps": 5000.4`. It cannot: `calldata.encode` raises
    `TypeError: not calldata encodable ... float`, and every value crossing a
    nondet boundary is calldata encoded. So the float branch is reachable only
    from a Python-side string, and is tested here rather than through `judge`.

    This is a finding about the platform, not a contract bug - the contract's
    own return values are float-free, which is what keeps `judge` encodable.
    """
    from genlayer.py import calldata

    module = contract_module()
    with pytest.raises(TypeError):
        calldata.encode({"split_bps": raw_float})

    # The coercion itself is correct where a float can actually reach it.
    assert module._normalize_split_bps(raw_float) == int(round(raw_float))


def test_the_contracts_own_judgment_payload_is_calldata_encodable(amicus, direct_vm, parties):
    """Whatever `judge` returns must survive the nondet boundary.

    A float anywhere in the leader's result would make every judgment fail with
    an opaque encoding error rather than a comparable one.
    """
    from genlayer.py import calldata

    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent, claimant_urls=[GOOD_URL]
    )
    mock_evidence_page(direct_vm, r"git\.example", GOOD_PAGE)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="SPLIT", split_bps=4321, citations=[GOOD_URL])
    direct_vm.sender = claimant
    amicus.judge(case_id)

    record = json.loads(amicus.get_judgments(case_id)[0])
    calldata.encode(record)  # raises if any float slipped into the record


@pytest.mark.parametrize("raw_split", ["about half", "N/A", "five thousand", True])
def test_unparseable_split_records_nothing(raw_split, amicus, direct_vm, parties):
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(
        direct_vm,
        raw=json.dumps({"outcome": "SPLIT", "split_bps": raw_split, "rationale": "r"}),
    )

    direct_vm.sender = claimant
    with direct_vm.expect_revert("[LLM_ERROR]"):
        amicus.judge(case_id)

    assert_nothing_recorded(amicus, direct_vm, case_id)


def test_split_bps_on_a_decisive_outcome_is_zeroed(amicus, direct_vm, parties):
    """A stray share must not silently become a payout instruction."""
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(
        direct_vm,
        raw=json.dumps({"outcome": "CLAIMANT", "split_bps": 7000, "rationale": "r"}),
    )

    direct_vm.sender = claimant
    amicus.judge(case_id)
    assert amicus.get_case(case_id)["split_bps"] == 0

    warp(direct_vm, WINDOW + APPEAL_WINDOW + 120)
    amicus.payout(case_id)
    record = assert_conserved(amicus, direct_vm, case_id)
    assert record["respondent_atto"] == 0


def test_invented_citations_are_dropped(amicus, direct_vm, parties):
    """A model cannot write a source nobody filed into the audit trail."""
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent, claimant_urls=[GOOD_URL]
    )
    mock_evidence_page(direct_vm, r"git\.example", GOOD_PAGE)
    mock_tamper(direct_vm, False)
    mock_judgment(
        direct_vm, outcome="CLAIMANT",
        citations=[GOOD_URL, "https://fabricated.example/proof", GOOD_URL],
    )

    direct_vm.sender = claimant
    amicus.judge(case_id)

    record = json.loads(amicus.get_judgments(case_id)[0])
    assert record["citations"] == [GOOD_URL]


def test_citations_are_capped(amicus, direct_vm, parties):
    module = contract_module()
    claimant, respondent = parties
    urls = ["https://c%d.example/x" % i for i in range(3)]
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent, claimant_urls=urls
    )
    mock_evidence_page(direct_vm, r"c\d\.example", "page")
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="CLAIMANT", citations=urls * 20)

    direct_vm.sender = claimant
    amicus.judge(case_id)

    record = json.loads(amicus.get_judgments(case_id)[0])
    assert len(record["citations"]) <= module.MAX_CITATIONS
    assert len(record["citations"]) == len(set(record["citations"]))


def test_enormous_rationale_is_capped_and_the_record_stays_valid_json(
    amicus, direct_vm, parties
):
    module = contract_module()
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="CLAIMANT", rationale="y" * 100_000)

    direct_vm.sender = claimant
    amicus.judge(case_id)

    raw = amicus.get_judgments(case_id)[0]
    record = json.loads(raw)  # must still parse
    assert len(record["rationale"]) <= module.MAX_RATIONALE_CHARS
    assert len(raw) <= module.MAX_JUDGMENT_RECORD_CHARS


def test_missing_rationale_is_tolerated(amicus, direct_vm, parties):
    """Prose is not load bearing: a judgment without one still stands."""
    claimant, respondent = parties
    case_id = ready_to_judge(amicus, direct_vm, claimant, respondent)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, raw=json.dumps({"outcome": "CLAIMANT"}))

    direct_vm.sender = claimant
    assert amicus.judge(case_id) == "CLAIMANT"
    assert json.loads(amicus.get_judgments(case_id)[0])["rationale"] == ""


def test_evidence_view_merges_the_tamper_finding_without_rewriting_the_record(
    amicus, direct_vm, parties
):
    claimant, respondent = parties
    case_id = ready_to_judge(
        amicus, direct_vm, claimant, respondent,
        claimant_statement="A perfectly ordinary account of events.",
    )
    stored_before = amicus.get_evidence(case_id)
    mock_tamper(direct_vm, False)
    mock_judgment(direct_vm, outcome="CLAIMANT")
    direct_vm.sender = claimant
    amicus.judge(case_id)

    after = [json.loads(e) for e in amicus.get_evidence(case_id)]
    assert all(entry["tampered"] is False for entry in after)
    # The statements themselves are byte-identical to what was filed.
    before = [json.loads(e) for e in stored_before]
    assert [e["statement"] for e in before] == [e["statement"] for e in after]
