import copy

import pytest

from docling_service.tests.conftest import GOLDEN_STEMS, assert_wire_contract, needs_tokenizer

pytestmark = needs_tokenizer


@pytest.mark.parametrize("stem", GOLDEN_STEMS)
def test_fixture_wire_satisfies_contract(wires, stem):
    assert_wire_contract(wires[stem])


@pytest.mark.parametrize(
    "mutate",
    [
        lambda w: w["chunks"][0].update(chunkIndex=5),
        lambda w: w["chunks"][0].update(type="list"),
        lambda w: w["chunks"][0]["flags"].append("ocr_applied"),
        lambda w: w["diagnostics"]["flagCounts"].update(kv_panel_detected=99),
        lambda w: w["producer"].update(normalizerVersion="99"),
    ],
)
def test_contract_check_rejects_violations(fixture_wire, mutate):
    wire = copy.deepcopy(fixture_wire)
    mutate(wire)
    with pytest.raises(AssertionError):
        assert_wire_contract(wire)
