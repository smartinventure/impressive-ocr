# SPDX-License-Identifier: AGPL-3.0-or-later
"""Wire types shared with the Node backend.

These mirror ``packages/shared/src/sidecar.ts`` exactly. When one side changes, change both
and bump ``PROTOCOL_VERSION`` — the backend refuses to talk to a sidecar reporting a
different version, which turns a silent field mismatch into a clear startup error.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from .config import PROTOCOL_VERSION

OutputFormat = Literal[
    "markdown",
    "json",
    "txt",
    "docx",
    "xlsx",
    "html",
    "searchable-pdf",
    "visualization",
]

TextLayerStrategy = Literal["always-ocr", "skip-if-text", "hybrid"]
LogLevel = Literal["debug", "info", "warning", "error"]


class EngineModules(BaseModel):
    """Per-module toggles; the main speed/quality dial."""

    doc_orientation_classify: bool = Field(default=True, alias="docOrientationClassify")
    doc_unwarping: bool = Field(default=False, alias="docUnwarping")
    textline_orientation: bool = Field(default=True, alias="textlineOrientation")
    table_recognition: bool = Field(default=True, alias="tableRecognition")
    formula_recognition: bool = Field(default=False, alias="formulaRecognition")
    chart_recognition: bool = Field(default=False, alias="chartRecognition")
    seal_recognition: bool = Field(default=False, alias="sealRecognition")

    model_config = {"populate_by_name": True}


class AdvancedEngineOptions(BaseModel):
    """Expert overrides forwarded verbatim to PaddleOCR's ``predict()``.

    Every field is ``None`` unless the pipeline set it, and ``None`` fields are dropped before
    the call rather than sent — so an unset knob leaves PaddleOCR on whatever its own default
    is today, instead of pinning whatever we believed it was when this was written.
    """

    text_det_limit_side_len: int | None = Field(default=None, alias="textDetLimitSideLen")
    text_det_box_thresh: float | None = Field(default=None, alias="textDetBoxThresh")
    text_det_thresh: float | None = Field(default=None, alias="textDetThresh")
    text_det_unclip_ratio: float | None = Field(default=None, alias="textDetUnclipRatio")
    text_rec_score_thresh: float | None = Field(default=None, alias="textRecScoreThresh")
    layout_threshold: float | None = Field(default=None, alias="layoutThreshold")
    markdown_ignore_labels: list[str] | None = Field(default=None, alias="markdownIgnoreLabels")

    model_config = {"populate_by_name": True}


class EngineOptions(BaseModel):
    profile: Literal["accurate", "fast"] = "fast"
    device: Literal["auto", "gpu", "cpu"] = "auto"
    raster_dpi: int = Field(default=200, alias="rasterDpi")
    max_pages_per_document: int = Field(default=0, alias="maxPagesPerDocument")
    modules: EngineModules = Field(default_factory=EngineModules)
    #: Defaulted, so a backend predating this field keeps working unchanged.
    advanced: AdvancedEngineOptions = Field(default_factory=AdvancedEngineOptions)
    #: Threads the engine may use. 0 means "decide from the machine".
    #:
    #: Paddle otherwise grabs every core, which on a laptop is the difference between a slow
    #: background job and an unusable computer.
    cpu_threads: int = Field(default=0, alias="cpuThreads")

    model_config = {"populate_by_name": True}


class JobRequest(BaseModel):
    """One document to process. Paths are already allowlist-checked by the backend."""

    job_id: str = Field(alias="jobId")
    source_path: str = Field(alias="sourcePath")
    work_dir: str = Field(alias="workDir")
    output_stem: str = Field(alias="outputStem")
    profile: Literal["accurate", "fast"]
    device: Literal["gpu", "cpu"]
    engine: EngineOptions
    text_layer_strategy: TextLayerStrategy = Field(alias="textLayerStrategy")
    formats: list[OutputFormat]
    #: Read only by the plain-text writer. Defaulted so an older backend, which does not
    #: send the field at all, keeps working instead of failing validation on every job.
    txt_encoding: str = Field(alias="txtEncoding", default="utf-8")

    model_config = {"populate_by_name": True}


# --- NDJSON stream messages -------------------------------------------------
# Serialised with by_alias=True so the backend receives camelCase.


class _Message(BaseModel):
    model_config = {"populate_by_name": True}


class AcceptedMessage(_Message):
    type: Literal["accepted"] = "accepted"
    job_id: str = Field(alias="jobId")
    page_count: int = Field(alias="pageCount")


class PageMessage(_Message):
    type: Literal["page"] = "page"
    job_id: str = Field(alias="jobId")
    page: int
    page_count: int = Field(alias="pageCount")
    used_existing_text_layer: bool = Field(default=False, alias="usedExistingTextLayer")
    elapsed_ms: float = Field(alias="elapsedMs")


class LogMessage(_Message):
    type: Literal["log"] = "log"
    job_id: str = Field(alias="jobId")
    level: LogLevel
    message: str
    page: int | None = None


class OutputMessage(_Message):
    type: Literal["output"] = "output"
    job_id: str = Field(alias="jobId")
    format: OutputFormat
    path: str
    bytes: int


class DoneMessage(_Message):
    type: Literal["done"] = "done"
    job_id: str = Field(alias="jobId")
    page_count: int = Field(alias="pageCount")
    duration_ms: float = Field(alias="durationMs")


class ErrorMessage(_Message):
    type: Literal["error"] = "error"
    job_id: str = Field(alias="jobId")
    code: str
    message: str
    retryable: bool


SidecarMessage = (
    AcceptedMessage | PageMessage | LogMessage | OutputMessage | DoneMessage | ErrorMessage
)


class HealthResponse(_Message):
    status: Literal["starting", "ready", "busy"]
    protocol_version: int = Field(default=PROTOCOL_VERSION, alias="protocolVersion")
    uptime_seconds: float = Field(alias="uptimeSeconds")


class CapabilitiesResponse(_Message):
    protocol_version: int = Field(default=PROTOCOL_VERSION, alias="protocolVersion")
    python_version: str = Field(alias="pythonVersion")
    paddle_version: str = Field(alias="paddleVersion")
    paddleocr_version: str = Field(alias="paddleocrVersion")
    device: Literal["gpu", "cpu"]
    profile: Literal["accurate", "fast"]
    supported_formats: list[OutputFormat] = Field(alias="supportedFormats")
