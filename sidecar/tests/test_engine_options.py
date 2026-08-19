# SPDX-License-Identifier: AGPL-3.0-or-later
"""The option mapping is where a silent typo would disable a feature for every user."""

from __future__ import annotations

from impressive_ocr_sidecar.core.protocol import EngineModules, EngineOptions
from impressive_ocr_sidecar.engines import structure_engine, vl_engine


class TestStructurePredictKwargs:
    def test_maps_every_module_toggle_to_paddles_use_prefix(self) -> None:
        options = EngineOptions(
            modules=EngineModules(
                docOrientationClassify=False,
                docUnwarping=True,
                textlineOrientation=False,
                tableRecognition=False,
                formulaRecognition=True,
                chartRecognition=True,
                sealRecognition=True,
            )
        )

        kwargs = structure_engine.build_predict_kwargs(options)

        assert kwargs == {
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": True,
            "use_textline_orientation": False,
            "use_table_recognition": False,
            "use_formula_recognition": True,
            "use_chart_recognition": True,
            "use_seal_recognition": True,
        }

    def test_defaults_keep_tables_on_and_the_expensive_modules_off(self) -> None:
        kwargs = structure_engine.build_predict_kwargs(EngineOptions())

        assert kwargs["use_table_recognition"] is True
        assert kwargs["use_formula_recognition"] is False
        assert kwargs["use_chart_recognition"] is False
        assert kwargs["use_seal_recognition"] is False

    def test_omits_the_page_limit_when_unlimited(self) -> None:
        kwargs = structure_engine.build_predict_kwargs(EngineOptions(maxPagesPerDocument=0))

        assert "page_num" not in kwargs

    def test_passes_the_page_limit_through_when_set(self) -> None:
        kwargs = structure_engine.build_predict_kwargs(EngineOptions(maxPagesPerDocument=25))

        assert kwargs["page_num"] == 25


class TestVlPredictKwargs:
    def test_only_forwards_the_preprocessing_switches(self) -> None:
        # The VLM handles layout, tables and formulas in one pass, so PP-StructureV3's
        # per-module toggles have no equivalent and must not be forwarded.
        kwargs = vl_engine.build_predict_kwargs(EngineOptions())

        assert set(kwargs) == {"use_doc_orientation_classify", "use_doc_unwarping"}
