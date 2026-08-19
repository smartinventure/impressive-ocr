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


class EngineOptions(BaseModel):
    profile: Literal["accurate", "fast"] = "fast"
    device: Literal["auto", "gpu", "cpu"] = "auto"
    language: str = "auto"
    model_tier: Literal["tiny", "small", "medium"] = Field(default="medium", alias="modelTier")
    raster_dpi: int = Field(default=200, alias="rasterDpi")
    max_pages_per_document: int = Field(default=0, alias="maxPagesPerDocument")
    modules: EngineModules = Field(default_factory=EngineModules)

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
