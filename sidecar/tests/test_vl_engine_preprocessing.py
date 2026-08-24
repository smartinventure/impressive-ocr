# SPDX-License-Identifier: AGPL-3.0-or-later
"""The accurate profile must not ask PaddleOCR-VL for a sub-model it never built.

Every document failed on this profile with::

    '_PaddleOCRVLPipeline' object has no attribute 'doc_preprocessor_pipeline'

PaddleOCR-VL ships with ``use_doc_preprocessor: False``, so its constructor never creates that
sub-pipeline. Passing ``use_doc_orientation_classify=True`` to ``predict()`` flips the pipeline
into using it anyway. Orientation detection is on by default, so this was not an edge case: it
was the whole profile, on every page.

The toggles now go to the constructor, where the sub-models are actually built, and predict()
stays silent about them so it can never contradict what was constructed.
"""

from __future__ import annotations

from impressive_ocr_sidecar.core.protocol import EngineModules, EngineOptions
from impressive_ocr_sidecar.engines.registry import create_engine
from impressive_ocr_sidecar.engines.vl_engine import VlEngine, build_predict_kwargs


class TestPredictKwargs:
    def test_the_preprocessing_switches_are_never_sent(self) -> None:
        # True is the dangerous one - it is what turned the sub-pipeline on - but False is
        # withheld too, so predict can never disagree with the constructor either way.
        for flag in (True, False):
            options = EngineOptions.model_validate(
                {
                    "modules": {
                        "docOrientationClassify": flag,
                        "docUnwarping": flag,
                    }
                }
            )
            kwargs = build_predict_kwargs(options)

            assert "use_doc_orientation_classify" not in kwargs
            assert "use_doc_unwarping" not in kwargs

    def test_page_limit_still_travels(self) -> None:
        options = EngineOptions.model_validate({"maxPagesPerDocument": 5})

        assert build_predict_kwargs(options)["page_num"] == 5

    def test_no_page_limit_sends_nothing(self) -> None:
        assert build_predict_kwargs(EngineOptions()) == {}


class TestModulesReachTheEngine:
    def test_the_vl_engine_is_given_the_module_toggles(self) -> None:
        # It used to be constructed with only a device, so the toggles could not reach the one
        # place that decides whether the sub-models exist.
        modules = EngineModules.model_validate({"docOrientationClassify": True})
        engine = create_engine("accurate", "gpu", modules)

        assert isinstance(engine, VlEngine)
        assert engine._modules.doc_orientation_classify is True

    def test_defaults_apply_when_no_modules_are_given(self) -> None:
        engine = VlEngine(device="cpu")

        assert engine._modules == EngineModules()
