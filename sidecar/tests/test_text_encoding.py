# SPDX-License-Identifier: AGPL-3.0-or-later
"""The pipeline's ``txtEncoding`` setting must reach the file on disk.

It did not. The setting existed in the shared schema and ``resolve_encoding`` existed to
translate it, but nothing ever called that function, the sidecar's ``JobRequest`` had no field
to carry it, and ``create_writers`` was invoked without it — so every .txt was written UTF-8
whatever the pipeline said.

Worse than inert: ``utf-8-bom`` is our own setting name, not a Python codec. Passed straight
through it reaches ``write_text`` and raises ``LookupError``, which ``TextWriter.write`` does
not catch, so the job would have died with an unhandled exception rather than a clear error.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from impressive_ocr_sidecar.core.protocol import JobRequest
from impressive_ocr_sidecar.engines.base import DocumentResult, PageResult
from impressive_ocr_sidecar.writers.base import WriteContext
from impressive_ocr_sidecar.writers.registry import create_writers
from impressive_ocr_sidecar.writers.text_writer import TextWriter, resolve_encoding


def _document(text: str) -> DocumentResult:
    page = PageResult(page_number=1, width=100.0, height=100.0, text=text)
    return DocumentResult(pages=[page], page_count=1)


def _context(tmp_path: Path) -> WriteContext:
    return WriteContext(work_dir=tmp_path, output_stem="scan", source_path=tmp_path / "scan.pdf")


class TestResolveEncoding:
    @pytest.mark.parametrize(
        ("setting", "codec"),
        [
            ("utf-8", "utf-8"),
            ("utf-8-bom", "utf-8-sig"),
            ("latin-1", "latin-1"),
            # Anything unrecognised falls back rather than raising: a value from a newer
            # backend should not take the job down.
            ("something-else", "utf-8"),
        ],
    )
    def test_maps_settings_onto_python_codecs(self, setting: str, codec: str) -> None:
        assert resolve_encoding(setting) == codec

    def test_writer_translates_rather_than_passing_the_setting_through(self) -> None:
        # The specific crash: "utf-8-bom" is not a codec Python knows.
        assert TextWriter(encoding="utf-8-bom")._encoding == "utf-8-sig"


class TestWrittenBytes:
    def test_bom_encoding_writes_a_byte_order_mark(self, tmp_path: Path) -> None:
        # Excel on a German Windows reads a plain UTF-8 .txt as ANSI and mangles every umlaut;
        # the BOM is what stops that.
        writer = TextWriter(encoding="utf-8-bom")
        written = writer.write(_document("Grüße"), _context(tmp_path))

        raw = Path(written[0].path).read_bytes()
        assert raw.startswith(b"\xef\xbb\xbf")
        assert "Grüße" in raw.decode("utf-8-sig")

    def test_plain_utf8_writes_no_marker(self, tmp_path: Path) -> None:
        writer = TextWriter(encoding="utf-8")
        written = writer.write(_document("Grüße"), _context(tmp_path))

        assert not Path(written[0].path).read_bytes().startswith(b"\xef\xbb\xbf")

    def test_latin1_encoding_is_honoured(self, tmp_path: Path) -> None:
        writer = TextWriter(encoding="latin-1")
        written = writer.write(_document("Grüße"), _context(tmp_path))

        raw = Path(written[0].path).read_bytes()
        # Two bytes in Latin-1 where UTF-8 would use four.
        assert raw.decode("latin-1").strip() == "Grüße"
        assert b"\xfc" in raw


class TestPlumbing:
    def test_create_writers_passes_the_encoding_to_the_text_writer(self) -> None:
        writers = create_writers(["txt"], txt_encoding="utf-8-bom")

        assert isinstance(writers[0], TextWriter)
        assert writers[0]._encoding == "utf-8-sig"

    def test_job_request_carries_the_encoding(self) -> None:
        request = JobRequest.model_validate(
            {
                "jobId": "j1",
                "sourcePath": "/tmp/a.pdf",
                "workDir": "/tmp/work",
                "outputStem": "a",
                "profile": "fast",
                "device": "cpu",
                "engine": {},
                "textLayerStrategy": "hybrid",
                "formats": ["txt"],
                "txtEncoding": "latin-1",
            }
        )

        assert request.txt_encoding == "latin-1"

    def test_job_request_defaults_when_an_older_backend_omits_it(self) -> None:
        # A backend from before this field existed must not fail validation on every job.
        request = JobRequest.model_validate(
            {
                "jobId": "j1",
                "sourcePath": "/tmp/a.pdf",
                "workDir": "/tmp/work",
                "outputStem": "a",
                "profile": "fast",
                "device": "cpu",
                "engine": {},
                "textLayerStrategy": "hybrid",
                "formats": ["txt"],
            }
        )

        assert request.txt_encoding == "utf-8"
