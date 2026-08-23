# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Impressive OCR — headless server image.
#
# Build from the repository root, not from this directory:
#     docker build -f deploy/docker/Dockerfile -t impressive-ocr .
#
# This is the slim image. PaddleOCR and its Python runtime are NOT baked in: the wheel is
# multiple gigabytes and comes in CPU and GPU flavours, so the app installs the right one on
# first run with the bundled `uv`. Everything it downloads lands in /data, which means the
# image stays small and a rebuild never re-downloads a runtime the volume already holds.
#
# The cost is real and worth stating: the first start needs network access and takes a while,
# and /data must be a persistent volume or that work is repeated on every container restart.

# ---------------------------------------------------------------------------------------
# Build stage — produces the same payload tree the release tarball ships.
# ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /src

# The whole tree in one layer, deliberately. A pnpm workspace's manifests are scattered
# across apps/ and packages/, so the usual "copy lockfile, install, copy sources" split would
# need every one of them listed here and would silently under-install the day somebody adds a
# package. This image is built by CI on a tag, where a cold cache costs minutes once.
COPY . .

# apps/desktop is a workspace member, so its manifest has to be here for the frozen lockfile
# to resolve — but nothing in this image runs Electron, and its binary is a ~100 MB download
# that would be discarded with the build stage.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @impressive-ocr/web build

# Set by BuildKit. Mapped to the names uv and our own scripts use.
ARG TARGETARCH=amd64
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    node deploy/fetch-uv.mjs --target server --arch "$arch"; \
    node deploy/package-server.mjs --arch "$arch" --stage-only /out

# ---------------------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="Impressive OCR Server" \
      org.opencontainers.image.description="Local-first OCR workstation, headless server" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/smartinventure/impressive-ocr"

# Shared libraries that PaddleOCR's wheels link against but do not vendor. They are installed
# here rather than at first run because the runtime bootstrap uses `uv`, which installs Python
# packages — it cannot install system packages, and the failure it produces otherwise is an
# ImportError deep inside OpenCV that says nothing about the real cause.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libgomp1 \
        libglib2.0-0 \
        libgl1 \
        libexpat1 \
    && rm -rf /var/lib/apt/lists/*

# An unprivileged, fixed uid so a bind-mounted /data has predictable ownership on the host.
RUN groupadd --gid 10001 impressive \
    && useradd --uid 10001 --gid 10001 --home-dir /data --shell /usr/sbin/nologin impressive

COPY --from=builder --chown=root:root /out /opt/impressive-ocr

# Everything mutable lives here: the SQLite database, the Python venv `uv` builds on first
# run, the downloaded models, the logs and the job working files. The application image
# itself stays read-only.
RUN mkdir -p /data && chown impressive:impressive /data
VOLUME ["/data"]

ENV NODE_ENV=production \
    IMPRESSIVE_OCR_DATA_DIR=/data \
    IMPRESSIVE_OCR_PORT=8084

# A container that binds loopback is unreachable even from its own host, so there would be no
# way to open the UI. Exposure is the operator's decision, made with the port mapping:
# publish to 127.0.0.1 on the host, or put a reverse proxy in front. The server logs a
# warning on startup if this leaves it unauthenticated on a network interface.
ENV IMPRESSIVE_OCR_BIND_ADDRESS=0.0.0.0

EXPOSE 8084

USER impressive
WORKDIR /data

# `/api/health` is one of the three paths the auth hook leaves public, so this keeps working
# after an administrator turns authentication on. Node's own fetch, rather than adding curl
# to the image for one line.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.IMPRESSIVE_OCR_PORT||8084)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/opt/impressive-ocr/bin/impressive-ocr-server"]
