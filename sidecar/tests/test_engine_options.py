# SPDX-License-Identifier: AGPL-3.0-or-later
"""The option mapping is where a silent typo would disable a feature for every user."""

from __future__ import annotations

from impressive_ocr_sidecar.core.protocol import EngineModules, EngineOptions
from impressive_ocr_sidecar.engines import structure_engine, vl_engine


class TestStructurePredictKwargs:
    def test_maps_every_module_toggle_to_paddles_use_prefix(self) -> None:
        options = EngineOptions(
            modules=EngineModules(
                docOrientationClassify=True,
                docUnwarping=True,
                textlineOrientation=True,
                tableRecognition=True,
                formulaRecognition=True,
                sealRecognition=True,
            )
        )

        kwargs = structure_engine.build_predict_kwargs(options)

        assert kwargs["use_doc_orientation_classify"] is True
        assert kwargs["use_doc_unwarping"] is True
        assert kwargs["use_textline_orientation"] is True
        assert kwargs["use_table_recognition"] is True
        assert kwargs["use_formula_recognition"] is True
        assert kwargs["use_seal_recognition"] is True

    def test_never_asks_for_chart_recognition(self) -> None:
        """PP-Chart2Table is not offered by this engine, so it is never loaded.

        It answers with numbers on a scale it invented: on charts drawn from known values with
        the printed labels removed it read 3 of 22 cells, giving 6.5/8.5/5.0/9.0/7.0 for bars
        of 40/65/25/80/55. With the values printed on the bars it scored 22 of 22, which shows
        it was reading them rather than measuring anything.

        Chart *text* still comes out — `chart_text.py` recovers it from the OCR this engine
        already runs — so what this drops is 1.4 GB and a wrong answer, not a capability.
        """
        options = EngineOptions(modules=EngineModules(chartRecognition=True))

        kwargs = structure_engine.build_predict_kwargs(options)

        assert "use_chart_recognition" not in kwargs

    def test_defaults_keep_tables_on_and_the_expensive_modules_off(self) -> None:
        kwargs = structure_engine.build_predict_kwargs(EngineOptions())

        assert kwargs["use_table_recognition"] is True
        assert kwargs["use_formula_recognition"] is False
        assert kwargs["use_seal_recognition"] is False

    def test_omits_the_page_limit_when_unlimited(self) -> None:
        kwargs = structure_engine.build_predict_kwargs(EngineOptions(maxPagesPerDocument=0))

        assert "page_num" not in kwargs

    def test_passes_the_page_limit_through_when_set(self) -> None:
        kwargs = structure_engine.build_predict_kwargs(EngineOptions(maxPagesPerDocument=5))

        assert kwargs["page_num"] == 5


class TestVlPredictKwargs:
    def test_forwards_no_preprocessing_switches(self) -> None:
        """The pair that must stay in the constructor.

        PaddleOCR-VL builds its doc preprocessor at construction or not at all, so asking for
        it here made every page fail with "object has no attribute doc_preprocessor_pipeline".
        """
        kwargs = vl_engine.build_predict_kwargs(EngineOptions())

        assert "use_doc_orientation_classify" not in kwargs
        assert "use_doc_unwarping" not in kwargs

    def test_defaults_ask_for_nothing(self) -> None:
        assert vl_engine.build_predict_kwargs(EngineOptions()) == {}

    def test_forwards_chart_recognition_when_asked(self) -> None:
        """The one module toggle this engine understands.

        It re-reads a chart region under a different task prompt rather than loading a second
        model. Not forwarding it made the switch silently inert on this profile, which looked
        from the outside like an engine that could not read charts.
        """
        options = EngineOptions(modules=EngineModules(chartRecognition=True))

        assert vl_engine.build_predict_kwargs(options)["use_chart_recognition"] is True

    def test_still_ignores_the_toggles_this_engine_has_no_answer_for(self) -> None:
        # Tables and formulas are part of the one pass; there is no sub-model to switch.
        options = EngineOptions(
            modules=EngineModules(tableRecognition=True, formulaRecognition=True)
        )
        kwargs = vl_engine.build_predict_kwargs(options)

        assert "use_table_recognition" not in kwargs
        assert "use_formula_recognition" not in kwargs

    def test_sends_nothing_when_chart_data_is_off(self) -> None:
        # Absent rather than False: an unset knob leaves PaddleOCR on its own default.
        options = EngineOptions(modules=EngineModules(chartRecognition=False))

        assert "use_chart_recognition" not in vl_engine.build_predict_kwargs(options)
