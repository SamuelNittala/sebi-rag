import re

from docling.datamodel.pipeline_options import TableFormerMode

from docling_service import converter


def test_no_vlm_description_or_enrichment():
    opts = converter.build_pipeline_options()
    assert opts.do_picture_description is False
    assert opts.do_chart_extraction is False
    assert opts.do_formula_enrichment is False
    assert opts.do_code_enrichment is False
    assert opts.enable_remote_services is False
    assert opts.allow_external_plugins is False


def test_structure_classification_and_ocr_are_explicit():
    opts = converter.build_pipeline_options()
    assert opts.do_ocr is False
    assert opts.do_table_structure is True
    assert opts.table_structure_options.mode == TableFormerMode.ACCURATE
    assert opts.table_structure_options.do_cell_matching is True
    assert opts.do_picture_classification is True
    assert opts.generate_page_images is False
    assert opts.generate_picture_images is False
    assert opts.accelerator_options.device == "cpu"


def test_runtime_settings_come_from_settings():
    settings = converter.Settings(models_dir="/models", num_threads=2, document_timeout_s=10)
    opts = converter.build_pipeline_options(settings)
    assert str(opts.artifacts_path) == "/models"
    assert opts.accelerator_options.num_threads == 2
    assert opts.document_timeout == 10


def test_options_hash_is_stable_and_ignores_runtime_settings():
    a = converter.pipeline_options_sha256(converter.build_pipeline_options())
    b = converter.pipeline_options_sha256(
        converter.build_pipeline_options(converter.Settings(models_dir="/x", num_threads=8, document_timeout_s=5))
    )
    assert re.fullmatch(r"[0-9a-f]{64}", a)
    assert a == b


def test_options_hash_changes_with_output_affecting_options():
    base = converter.pipeline_options_sha256(converter.build_pipeline_options())

    def changed(mutate):
        opts = converter.build_pipeline_options()
        mutate(opts)
        return converter.pipeline_options_sha256(opts)

    assert changed(lambda o: setattr(o, "do_ocr", True)) != base
    assert changed(lambda o: setattr(o.table_structure_options, "mode", TableFormerMode.FAST)) != base
    assert changed(lambda o: setattr(o.table_structure_options, "do_cell_matching", False)) != base
    assert changed(lambda o: setattr(o, "do_picture_classification", False)) != base
    assert converter.pipeline_options_sha256(converter.build_pipeline_options(), chunk_max_tokens=512) != base


def test_parser_version_format():
    version = converter.parser_version()
    sha = converter.pipeline_options_sha256(converter.build_pipeline_options())
    assert version == f"docling-2.132.0+norm-1+opts-{sha[:12]}"
    assert re.fullmatch(r"docling-\d+\.\d+\.\d+\+norm-[1-9]\d*\+opts-[0-9a-f]{12}", version)


def test_producer_versions():
    producer = converter.producer()
    assert producer["doclingVersion"] == "2.132.0"
    assert producer["doclingCoreVersion"] == "2.99.0"
    assert producer["doclingIbmModelsVersion"] == "4.0.3"
    assert producer["normalizerVersion"] == "1"
    assert producer["parserVersion"] == converter.parser_version()


def test_options_hash_is_independent_of_hash_seed():
    import os
    import subprocess
    import sys
    from pathlib import Path

    code = "from docling_service import converter as c; print(c.pipeline_options_sha256(c.build_pipeline_options()))"
    python_dir = str(Path(converter.__file__).resolve().parents[1])
    hashes = {
        subprocess.run(
            [sys.executable, "-c", code],
            env={**os.environ, "PYTHONHASHSEED": seed, "PYTHONPATH": python_dir},
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        for seed in ("1", "2", "3")
    }
    assert hashes == {converter.pipeline_options_sha256(converter.build_pipeline_options())}
