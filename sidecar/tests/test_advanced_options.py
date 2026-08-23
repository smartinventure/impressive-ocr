# SPDX-License-Identifier: AGPL-3.0-or-later
"""Expert overrides must reach ``predict()`` under the names PaddleOCR expects.

Two failure modes, both silent. A misspelled key is swallowed by ``**kwargs`` and the setting
simply never applies. And a knob the pipeline left alone must be *absent* from the call, not
sent as ``None`` or as a default we guessed — otherwise every saved pipeline pins today's
values and a future PaddleOCR can never improve them.
"""

from __future__ import annotations

import inspect

from impressive_ocr_sidecar.core.protocol import AdvancedEngineOptions, EngineOptions
from impressive_ocr_sidecar.engines.structure_engine import (
    build_advanced_kwargs,
    build_predict_kwargs,
)


class TestUnsetMeansAbsent:
    def test_nothing_is_sent_when_nothing_was_set(self) -> None:
        assert build_advanced_kwargs(AdvancedEngineOptions()) == {}

    def test_engine_defaults_add_no_advanced_keys(self) -> None:
        # A pipeline that never opened the expert panel must produce exactly the call it did
        # before the panel existed.
        kwargs = build_predict_kwargs(EngineOptions())

        prefixes = ("text_det", "text_rec", "layout_", "markdown_")
        assert not any(key.startswith(prefixes) for key in kwargs)

    def test_only_the_fields_that_were_set_appear(self) -> None:
        advanced = AdvancedEngineOptions.model_validate({"textRecScoreThresh": 0.5})

        assert build_advanced_kwargs(advanced) == {"text_rec_score_thresh": 0.5}


class TestNames:
    def test_every_field_maps_to_a_parameter_predict_accepts(self) -> None:
        """The guard against a typo: check the emitted keys against PaddleOCR's own signature.

        Skipped where PaddleOCR is absent, which is the normal state in CI — it is a
        multi-gigabyte dependency installed at runtime, not a test dependency.
        """
        try:
            from paddleocr import PPStructureV3
        except ImportError:  # pragma: no cover - depends on the machine, not the code
            import pytest

            pytest.skip("PaddleOCR is not installed in this environment")

        accepted = set(inspect.signature(PPStructureV3.predict).parameters)
        every_field = AdvancedEngineOptions.model_validate(
            {
                "textDetLimitSideLen": 736,
                "textDetBoxThresh": 0.6,
                "textDetThresh": 0.3,
                "textDetUnclipRatio": 1.5,
                "textRecScoreThresh": 0.0,
                "layoutThreshold": 0.5,
                "markdownIgnoreLabels": ["header"],
            }
        )

        unknown = set(build_advanced_kwargs(every_field)) - accepted
        assert unknown == set(), f"predict() does not accept: {sorted(unknown)}"

    def test_zero_is_a_value_and_not_treated_as_unset(self) -> None:
        # `exclude_none`, deliberately, rather than a falsy check: 0.0 is a legitimate and
        # meaningful setting for every threshold here.
        advanced = AdvancedEngineOptions.model_validate({"textDetBoxThresh": 0.0})

        assert build_advanced_kwargs(advanced) == {"text_det_box_thresh": 0.0}


class TestCarriedOverTheWire:
    def test_engine_options_accept_the_camel_case_payload(self) -> None:
        options = EngineOptions.model_validate(
            {"advanced": {"textDetUnclipRatio": 2.0, "markdownIgnoreLabels": ["header", "footer"]}}
        )

        assert build_advanced_kwargs(options.advanced) == {
            "text_det_unclip_ratio": 2.0,
            "markdown_ignore_labels": ["header", "footer"],
        }

    def test_an_older_backend_omitting_the_block_still_validates(self) -> None:
        options = EngineOptions.model_validate({"rasterDpi": 300})

        assert build_advanced_kwargs(options.advanced) == {}
