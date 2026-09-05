#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Impressive OCR - install the headless server with Docker.
#
#   curl -fsSL https://raw.githubusercontent.com/smartinventure/impressive-ocr/main/deploy/installer/install-impressive-ocr.sh | bash
#
# or, to read it first (which you should, for any script piped into a shell):
#
#   curl -fsSLO https://raw.githubusercontent.com/smartinventure/impressive-ocr/main/deploy/installer/install-impressive-ocr.sh
#   less install-impressive-ocr.sh
#   bash install-impressive-ocr.sh
#
# What it does:
#   1. Checks for Docker and the compose plugin.
#   2. Writes a docker-compose.yml into the install directory (default ~/impressive-ocr).
#   3. Starts the container.
#   4. Installs a host-side updater so the app's "Update now" button works, because a
#      container cannot pull a new image and recreate itself.
#
# Options:
#   --dir <path>      Install directory          (default: ~/impressive-ocr)
#   --port <port>     Host port to bind          (default: 8084)
#   --no-updater      Skip the host-side updater; update by hand instead
#   --uninstall       Remove the updater, stop the container, and stop
#   --yes             Do not prompt
#
# It never deletes your data. --uninstall leaves the Docker volume alone; removing that is a
# separate, deliberate `docker volume rm`, and the script tells you the command rather than
# running it.

set -euo pipefail

INSTALL_DIR="${HOME}/impressive-ocr"
HOST_PORT=8084
INSTALL_UPDATER=1
UNINSTALL=0
ASSUME_YES=0

IMAGE='ghcr.io/smartinventure/impressive-ocr:latest'
SERVICE_NAME='impressive-ocr'
# Must match UPDATE_CONTROL_DIR / HOST_UPDATE_MARKER_FILE / UPDATE_REQUEST_FILE in
# packages/shared/src/update.ts. A rename on one side that missed the other would leave the
# in-app button visible and inert, which is the one failure mode worth naming here.
CONTROL_DIR_NAME='control'
MARKER_FILE='host-update-enabled'
REQUEST_FILE='update-request'
CONTAINER_UID=10001
CONTAINER_GID=10001

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$1"; }
good() { printf '\033[32m    %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
fail() { printf '\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --port) HOST_PORT="${2:?--port needs a number}"; shift 2 ;;
    --no-updater) INSTALL_UPDATER=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '3,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

if [[ ! "$HOST_PORT" =~ ^[0-9]+$ ]] || (( HOST_PORT < 1 || HOST_PORT > 65535 )); then
  fail "Not a port number: $HOST_PORT"
fi

# --- Docker -----------------------------------------------------------------

require_docker() {
  command -v docker >/dev/null 2>&1 || fail \
    'Docker is not installed. See https://docs.docker.com/engine/install/'

  docker info >/dev/null 2>&1 || fail \
    'Docker is installed but not usable by this user. Start it, or add yourself to the "docker" group and log in again.'

  # `docker compose` (v2 plugin), not the retired `docker-compose` script. Every command
  # below uses the plugin form, so the check has to be for that.
  docker compose version >/dev/null 2>&1 || fail \
    'The Docker Compose plugin is missing. See https://docs.docker.com/compose/install/'
}

# --- Uninstall --------------------------------------------------------------

do_uninstall() {
  step "Removing the host updater"

  if [[ -f /etc/systemd/system/impressive-ocr-update.path ]]; then
    # `|| true` throughout: an already-stopped unit must not abort the rest of the removal.
    sudo systemctl disable --now impressive-ocr-update.path >/dev/null 2>&1 || true
    sudo rm -f /etc/systemd/system/impressive-ocr-update.path \
               /etc/systemd/system/impressive-ocr-update.service
    sudo systemctl daemon-reload || true
    good 'systemd units removed.'
  fi

  if crontab -l 2>/dev/null | grep -q 'impressive-ocr-update.sh'; then
    crontab -l 2>/dev/null | grep -v 'impressive-ocr-update.sh' | crontab -
    good 'cron entry removed.'
  fi

  rm -f "${INSTALL_DIR}/${CONTROL_DIR_NAME}/${MARKER_FILE}" \
        "${INSTALL_DIR}/${CONTROL_DIR_NAME}/${REQUEST_FILE}" \
        "${INSTALL_DIR}/impressive-ocr-update.sh"

  if [[ -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
    step 'Stopping the container'
    (cd "$INSTALL_DIR" && docker compose down) || true
  fi

  printf '\n'
  good 'Uninstalled.'
  info "Your data is untouched, in the Docker volume 'impressive-ocr-data'."
  info "To delete it as well:  docker volume rm impressive-ocr-data"
  info "The install directory  ${INSTALL_DIR}  was left in place."
}

if [[ "$UNINSTALL" == "1" ]]; then
  require_docker
  do_uninstall
  exit 0
fi

# --- Install ----------------------------------------------------------------

require_docker

step 'Impressive OCR - headless server'
info "Install directory:  ${INSTALL_DIR}"
info "Web UI will be at:  http://127.0.0.1:${HOST_PORT}"
info "Host updater:       $( [[ $INSTALL_UPDATER == 1 ]] && echo 'yes' || echo 'no (--no-updater)' )"
printf '\n'

if [[ "$ASSUME_YES" != "1" ]]; then
  # Read from the terminal rather than stdin: this script is designed to be piped from curl,
  # where stdin is the script itself and a plain `read` would consume it and answer instantly.
  if [[ -r /dev/tty ]]; then
    printf 'Continue? [Y/n] '
    read -r reply </dev/tty
    case "$reply" in [nN]*) echo 'Cancelled.'; exit 0 ;; esac
  else
    warn 'No terminal to prompt on; continuing. Pass --yes to silence this.'
  fi
fi

mkdir -p "${INSTALL_DIR}/${CONTROL_DIR_NAME}" \
         "${INSTALL_DIR}/documents" \
         "${INSTALL_DIR}/output"

# --- compose file -----------------------------------------------------------

step 'Writing docker-compose.yml'

COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
if [[ -f "$COMPOSE_FILE" ]]; then
  backup="${COMPOSE_FILE}.$(date +%Y%m%d%H%M%S).bak"
  cp "$COMPOSE_FILE" "$backup"
  warn "An existing compose file was backed up to $(basename "$backup")"
fi

cat > "$COMPOSE_FILE" <<COMPOSE
# SPDX-License-Identifier: AGPL-3.0-or-later
# Written by install-impressive-ocr.sh. Safe to edit; the installer backs it up first.

services:
  ${SERVICE_NAME}:
    image: ${IMAGE}
    container_name: ${SERVICE_NAME}
    restart: unless-stopped

    ports:
      # Loopback on purpose. The API can read and write every folder on its allowlist, so
      # publish it further only behind a reverse proxy with authentication enabled.
      - '127.0.0.1:${HOST_PORT}:8084'

    volumes:
      # Database, Python runtime, models, logs. A named volume: several gigabytes the host
      # never needs to look inside.
      - impressive-ocr-data:/data

      # The update handshake, and the only reason this is a bind mount rather than a volume:
      # a script on the host has to be able to see a file the container writes. It holds two
      # empty files and nothing else.
      - ./${CONTROL_DIR_NAME}:/control

      # Documents in, results out. Read-only in: the watcher only ever reads its input.
      - ./documents:/documents:ro
      - ./output:/output

    environment:
      IMPRESSIVE_OCR_PORT: '8084'
      IMPRESSIVE_OCR_DATA_DIR: /data
      # Absent on a hand-started container, which is exactly how the app decides whether to
      # offer the one-click update button.
      IMPRESSIVE_OCR_UPDATE_CONTROL_DIR: /control

    # PaddleOCR is memory-hungry and a large scanned PDF can spike past a gigabyte. Without a
    # limit an OOM takes the host down with it; with one, only this container dies and
    # restart: unless-stopped brings it back.
    deploy:
      resources:
        limits:
          memory: 4G

    healthcheck:
      test:
        [
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:8084/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3

volumes:
  impressive-ocr-data:
COMPOSE

good "$(basename "$COMPOSE_FILE") written."

# The container runs as uid 10001 and must be able to create a file in the control directory.
# Without this the button appears and every click fails with EACCES.
if ! chown "${CONTAINER_UID}:${CONTAINER_GID}" "${INSTALL_DIR}/${CONTROL_DIR_NAME}" 2>/dev/null; then
  sudo chown "${CONTAINER_UID}:${CONTAINER_GID}" "${INSTALL_DIR}/${CONTROL_DIR_NAME}" 2>/dev/null || {
    warn 'Could not set ownership of the control directory.'
    info "The app will not be able to request updates. Fix with:"
    info "  sudo chown ${CONTAINER_UID}:${CONTAINER_GID} ${INSTALL_DIR}/${CONTROL_DIR_NAME}"
  }
fi

# --- host updater -----------------------------------------------------------

install_host_updater() {
  step 'Installing the host updater'

  local updater="${INSTALL_DIR}/impressive-ocr-update.sh"
  cat > "$updater" <<UPDATER
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Pull the newest image and recreate the container. Written by install-impressive-ocr.sh.
#
# Runs on the HOST, not in the container, because a container cannot recreate itself. It is
# triggered by the presence of the request file the app writes -- and it never reads that
# file's contents. The command below is fixed. Nothing inside the container can influence
# what runs here, which is the whole reason the app is not given the Docker socket instead.

set -euo pipefail

INSTALL_DIR='${INSTALL_DIR}'
REQUEST="\${INSTALL_DIR}/${CONTROL_DIR_NAME}/${REQUEST_FILE}"

[[ -f "\$REQUEST" ]] || exit 0

# One updater at a time. A cron poll and a manual run overlapping would have two
# \`docker compose up\` racing over the same container.
exec 9>"\${INSTALL_DIR}/.update.lock"
flock -n 9 || exit 0

# Claim the request before doing the work, so a failed update does not loop forever: the
# button can be pressed again, but a crash mid-pull will not re-trigger on the next tick.
rm -f "\$REQUEST"

cd "\$INSTALL_DIR"
logger -t impressive-ocr-update 'Updating Impressive OCR' 2>/dev/null || true

docker compose pull
docker compose up -d
docker image prune -f

logger -t impressive-ocr-update 'Update complete' 2>/dev/null || true
UPDATER
  chmod +x "$updater"
  good "$(basename "$updater") written."

  # A systemd path unit is event-driven and fires the moment the file appears. Cron is the
  # fallback for a machine without systemd or without root: it polls once a minute, so the
  # button takes up to a minute to act rather than being instant.
  if [[ "$(id -u)" == "0" || -n "${SUDO_USER:-}" ]] && command -v systemctl >/dev/null 2>&1 \
     && sudo -n true 2>/dev/null; then
    install_systemd_watcher "$updater"
  else
    install_cron_watcher "$updater"
  fi
}

install_systemd_watcher() {
  local updater="$1"

  sudo tee /etc/systemd/system/impressive-ocr-update.service >/dev/null <<UNIT
[Unit]
Description=Update Impressive OCR

[Service]
Type=oneshot
ExecStart=${updater}
UNIT

  sudo tee /etc/systemd/system/impressive-ocr-update.path >/dev/null <<UNIT
[Unit]
Description=Watch for an Impressive OCR update request

[Path]
PathExists=${INSTALL_DIR}/${CONTROL_DIR_NAME}/${REQUEST_FILE}

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload
  sudo systemctl enable --now impressive-ocr-update.path >/dev/null
  good 'systemd path unit installed - updates apply the moment they are requested.'
}

install_cron_watcher() {
  local updater="$1"

  if crontab -l 2>/dev/null | grep -q 'impressive-ocr-update.sh'; then
    good 'cron entry already present.'
    return
  fi
  # Appended to the existing crontab rather than replacing it.
  { crontab -l 2>/dev/null || true; echo "* * * * * ${updater} >/dev/null 2>&1"; } | crontab -
  good 'cron entry installed - updates apply within a minute of being requested.'
}

if [[ "$INSTALL_UPDATER" == "1" ]]; then
  if ! command -v flock >/dev/null 2>&1; then
    warn 'flock is not available; skipping the host updater.'
    info 'Update by hand instead:  cd '"${INSTALL_DIR}"' && docker compose pull && docker compose up -d'
    INSTALL_UPDATER=0
  else
    install_host_updater
  fi
fi

# --- start ------------------------------------------------------------------

step 'Starting Impressive OCR'
(cd "$INSTALL_DIR" && docker compose pull && docker compose up -d)

# The marker goes in last, and only if everything above worked. Its presence is what makes
# the in-app button appear, so writing it earlier would advertise an updater that a failure
# further down had left uninstalled.
if [[ "$INSTALL_UPDATER" == "1" ]]; then
  marker="${INSTALL_DIR}/${CONTROL_DIR_NAME}/${MARKER_FILE}"
  : > "$marker"
  chown "${CONTAINER_UID}:${CONTAINER_GID}" "$marker" 2>/dev/null \
    || sudo chown "${CONTAINER_UID}:${CONTAINER_GID}" "$marker" 2>/dev/null || true
fi

printf '\n'
good 'Impressive OCR is running.'
printf '\n'
info "Open:       http://127.0.0.1:${HOST_PORT}"
info "Logs:       cd ${INSTALL_DIR} && docker compose logs -f"
info "Stop:       cd ${INSTALL_DIR} && docker compose down"
info "Documents:  ${INSTALL_DIR}/documents   (input, read-only to the app)"
info "Results:    ${INSTALL_DIR}/output"
printf '\n'
if [[ "$INSTALL_UPDATER" == "1" ]]; then
  info 'Updates:    press "Update now" in the app when one is offered.'
else
  info "Updates:    cd ${INSTALL_DIR} && docker compose pull && docker compose up -d"
fi
printf '\n'
warn 'First start downloads several gigabytes: the Python runtime, the OCR models and the'
info 'inference engine. It happens once. Watch it with `docker compose logs -f`.'
