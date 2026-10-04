import copy

import pytest

from docling_service.tests.conftest import GOLDEN_STEMS, assert_wire_contract, needs_tokenizer

pytestmark = needs_tokenizer


@pytest.mark.parametrize("stem", GOLDEN_STEMS)
def test_fixture_wire_satisfies_contract(wires, stem):
    assert_wire_contract(wires[stem])


def _first(wire, predicate):
    return next(c for c in wire["chunks"] if predicate(c))


def _add_flag(wire, chunk, flag):
    """Adds `flag` keeping diagnostics.flagCounts consistent, so only the flag rule can fail."""
    chunk["flags"].append(flag)
    counts = wire["diagnostics"]["flagCounts"]
    wire["diagnostics"]["flagCounts"] = dict(sorted({**counts, flag: counts.get(flag, 0) + 1}.items()))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda w: w["chunks"][0].update(chunkIndex=5),
        lambda w: w["chunks"][0].update(type="list"),
        lambda w: w["chunks"][0]["flags"].append("ocr_applied"),
        lambda w: w["diagnostics"]["flagCounts"].update(kv_panel_detected=99),
        lambda w: w["producer"].update(normalizerVersion="99"),
        # chart_values_in_table: picture chunks only, and only beside an unbound-chart flag.
        lambda w: _add_flag(w, _first(w, lambda c: "chart_pairs_extracted" in c["flags"]), "chart_values_in_table"),
        lambda w: _add_flag(w, _first(w, lambda c: c["type"] == "table"), "chart_values_in_table"),
    ],
)
def test_contract_check_rejects_violations(fixture_wire, mutate):
    wire = copy.deepcopy(fixture_wire)
    mutate(wire)
    with pytest.raises(AssertionError):
        assert_wire_contract(wire)
