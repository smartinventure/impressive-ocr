# SPDX-License-Identifier: AGPL-3.0-or-later
"""API tests.

Neither ``/health`` nor ``/capabilities`` may touch the engine — the backend polls health
while a multi-gigabyte model load is still running, and it asks for capabilities before
deciding whether to start a job at all. These tests therefore run with PaddleOCR absent,
which also proves the endpoints stay useful before the runtime is installed.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from impressive_ocr_sidecar.api.app import create_app
from impressive_ocr_sidecar.core.config import AUTH_HEADER, PROTOCOL_VERSION, SidecarConfig


@pytest.fixture
def client(config: SidecarConfig) -> TestClient:
    return TestClient(create_app(config))


@pytest.fixture
def auth(config: SidecarConfig) -> dict[str, str]:
    return {AUTH_HEADER: config.auth_token}


class TestHealth:
    def test_answers_without_a_token(self, client: TestClient) -> None:
        # The backend's restart decision must not depend on getting auth right.
        response = client.get("/health")

        assert response.status_code == 200
        assert response.json()["protocolVersion"] == PROTOCOL_VERSION

    def test_reports_starting_until_the_engine_is_loaded(self, client: TestClient) -> None:
        assert client.get("/health").json()["status"] == "starting"


class TestCapabilities:
    def test_rejects_a_missing_token(self, client: TestClient) -> None:
        assert client.get("/capabilities").status_code == 401

    def test_rejects_a_wrong_token(self, client: TestClient) -> None:
        response = client.get("/capabilities", headers={AUTH_HEADER: "not-the-token"})

        assert response.status_code == 401

    def test_reports_the_pinned_profile_and_device(
        self, client: TestClient, auth: dict[str, str]
    ) -> None:
        body = client.get("/capabilities", headers=auth).json()

        assert body["profile"] == "fast"
        assert body["device"] == "cpu"
        assert body["protocolVersion"] == PROTOCOL_VERSION

    def test_omits_searchable_pdf_until_its_writer_exists(
        self, client: TestClient, auth: dict[str, str]
    ) -> None:
        # The backend greys the option out based on this list, so an unimplemented format
        # must never appear in it.
        formats = client.get("/capabilities", headers=auth).json()["supportedFormats"]

        assert "markdown" in formats
        assert "searchable-pdf" not in formats

    def test_reports_paddle_as_not_installed_before_the_runtime_bootstrap(
        self, client: TestClient, auth: dict[str, str]
    ) -> None:
        body = client.get("/capabilities", headers=auth).json()

        assert body["paddleocrVersion"] == "not-installed"


class TestJobs:
    def test_requires_a_token(self, client: TestClient) -> None:
        assert client.post("/jobs", json={}).status_code == 401

    def test_rejects_a_malformed_request(
        self, client: TestClient, auth: dict[str, str]
    ) -> None:
        response = client.post("/jobs", json={"jobId": "j1"}, headers=auth)

        assert response.status_code == 422

    def test_streams_a_retryable_error_when_paddleocr_is_missing(
        self, client: TestClient, auth: dict[str, str], digital_pdf: object, tmp_path: object
    ) -> None:
        # Without PaddleOCR the engine cannot load. That is an infrastructure problem, not a
        # bad document, so it must come back retryable rather than sending the file to
        # quarantine.
        request = {
            "jobId": "job-1",
            "sourcePath": str(digital_pdf),
            "workDir": str(tmp_path),
            "outputStem": "digital",
            "profile": "fast",
            "device": "cpu",
            "engine": {},
            "textLayerStrategy": "always-ocr",
            "formats": ["markdown"],
        }

        with client.stream("POST", "/jobs", json=request, headers=auth) as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("application/x-ndjson")
            messages = [json.loads(line) for line in response.iter_lines() if line]

        assert messages, "expected at least one NDJSON message"
        assert messages[-1]["type"] == "error"
        assert messages[-1]["retryable"] is True
