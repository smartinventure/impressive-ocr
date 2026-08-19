# SPDX-License-Identifier: AGPL-3.0-or-later
"""Typed errors carrying the retry decision the backend's queue needs."""

from __future__ import annotations


class SidecarError(Exception):
    """Base for every error the sidecar reports over the NDJSON stream.

    ``retryable`` is the important field: the backend uses it to decide between a backoff
    retry and going straight to quarantine. Getting it wrong either wastes the queue's time
    on a corrupt file or discards a document because a GPU was briefly out of memory.
    """

    code = "sidecar-error"
    retryable = False

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class UnsupportedInputError(SidecarError):
    """The file type is not something any engine in this build can read."""

    code = "unsupported-input"
    retryable = False


class CorruptDocumentError(SidecarError):
    """The file claims a supported type but cannot be parsed."""

    code = "corrupt-document"
    retryable = False


class OutputWriteError(SidecarError):
    """A writer failed. Usually a full disk or a locked file, both worth retrying."""

    code = "output-write-failed"
    retryable = True


class EngineLoadError(SidecarError):
    """Model weights could not be loaded — missing download, or a broken install."""

    code = "engine-load-failed"
    retryable = True


class DeviceMemoryError(SidecarError):
    """GPU or host memory exhausted. Retrying after other jobs drain often succeeds."""

    code = "out-of-memory"
    retryable = True


class JobCancelledError(SidecarError):
    """The backend disconnected or pause was requested; not a failure."""

    code = "cancelled"
    retryable = False
