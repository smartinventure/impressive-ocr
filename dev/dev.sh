#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Start and stop the Impressive OCR development stack (API + web UI) from a menu.
#
# Works on Linux, macOS and Git Bash on Windows. Port lookup and process killing differ
# across the three, so both are behind small wrappers rather than assuming lsof exists.
#
# Usage:  ./dev/dev.sh              interactive menu
#         ./dev/dev.sh start
#         ./dev/dev.sh stop
#         ./dev/dev.sh doctor      check prerequisites, offer to install them

set -uo pipefail

# ---------------------------------------------------------------- layout ----

DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$DEV_DIR")"
RUN_DIR="$DEV_DIR/.run"
LOG_FILE="$RUN_DIR/dev.log"
PID_FILE="$RUN_DIR/dev.pid"
ENV_FILE="$DEV_DIR/dev.env"

# Must match DEV_PORT in apps/web/vite.config.ts and DEFAULT_PORT in
# packages/shared/src/settings.ts respectively.
WEB_PORT=5273
API_PORT=8084

# ------------------------------------------------------------ presentation ----

if [ -t 1 ]; then
  C_HEAD=$'\033[36m'; C_GOOD=$'\033[32m'; C_WARN=$'\033[33m'
  C_BAD=$'\033[31m';  C_DIM=$'\033[90m';  C_OFF=$'\033[0m'
else
  C_HEAD=''; C_GOOD=''; C_WARN=''; C_BAD=''; C_DIM=''; C_OFF=''
fi

head_() { printf '%s%s%s\n' "$C_HEAD" "$*" "$C_OFF"; }
good_() { printf '%s%s%s\n' "$C_GOOD" "$*" "$C_OFF"; }
warn_() { printf '%s%s%s\n' "$C_WARN" "$*" "$C_OFF"; }
bad_()  { printf '%s%s%s\n' "$C_BAD"  "$*" "$C_OFF"; }
dim_()  { printf '%s%s%s\n' "$C_DIM"  "$*" "$C_OFF"; }
rule_() { dim_ '--------------------------------------------------------------------------'; }

is_windows() { case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) return 0 ;; *) return 1 ;; esac }

# What this machine needs and how to get it: collect_prerequisites, check_prerequisites,
# install_prerequisites. Kept separate because the launcher is long enough.
# shellcheck source=dev/preflight.sh
. "$DEV_DIR/preflight.sh"

# ------------------------------------------------------------ environment ----

load_env_file() {
  # KEY=VALUE lines; blanks and # comments ignored. Values are used verbatim.
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "${line# }" in '' | '#'*) continue ;; esac
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"; value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    value="${value#"${value%%[![:space:]]*}"}"
    export "$key=$value"
  done < "$ENV_FILE"
}

default_data_dir() {
  # Sibling of the repository, so it lands on the same drive as the checkout. The
  # application's own default is %LOCALAPPDATA% / ~/.local/share, and the OCR model weights
  # underneath it run to several gigabytes.
  printf '%s/.impressive-ocr-data' "$(dirname "$REPO_ROOT")"
}

resolve_environment() {
  load_env_file
  : "${IMPRESSIVE_OCR_DATA_DIR:=$(default_data_dir)}"
  : "${IMPRESSIVE_OCR_PORT:=$API_PORT}"
  export IMPRESSIVE_OCR_DATA_DIR IMPRESSIVE_OCR_PORT
  API_PORT="$IMPRESSIVE_OCR_PORT"
}

# ------------------------------------------------------------- processes ----

listener_pids() {
  # Process IDs listening on $1, printed one per line.
  local port="$1"
  if is_windows; then
    # netstat state words are localised - a German Windows prints ABHOEREN, not LISTENING -
    # so the listening socket is identified by its *remote* address being the wildcard
    # instead. Matching the local address alone also catches TIME_WAIT rows on the same
    # port, which report PID 0 and would otherwise be handed to taskkill.
    netstat -ano 2>/dev/null | awk -v p=":$port" '
      $1 == "TCP" \
        && substr($2, length($2) - length(p) + 1) == p \
        && ($3 == "0.0.0.0:0" || $3 == "[::]:0") \
        && $NF + 0 > 0 { print $NF }
    ' | sort -u
  elif command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$port" -s TCP:LISTEN 2>/dev/null | sort -u
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
  fi
}

port_busy() { [ -n "$(listener_pids "$1")" ]; }

kill_tree() {
  # pnpm spawns vite and tsx; killing only the parent leaves both holding their ports.
  local pid="$1"
  if is_windows; then
    taskkill //PID "$pid" //T //F >/dev/null 2>&1
  else
    pkill -TERM -P "$pid" >/dev/null 2>&1
    kill -TERM "$pid" >/dev/null 2>&1
    sleep 0.5
    pkill -KILL -P "$pid" >/dev/null 2>&1
    kill -KILL "$pid" >/dev/null 2>&1
  fi
  return 0
}

# ---------------------------------------------------------------- actions ----

wait_for_api() {
  local deadline=$((SECONDS + 90))
  printf '  waiting for the API '
  while [ $SECONDS -lt $deadline ]; do
    if curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$API_PORT/api/system/status"; then
      good_ ' ready'; return 0
    fi
    printf '.'
    sleep 1
  done
  bad_ ' timed out'
  return 1
}

runtime_hint() {
  local state
  state="$(curl -sf --max-time 5 "http://127.0.0.1:$API_PORT/api/system/runtime" 2>/dev/null \
    | grep -oE '"state":"[^"]+"' | cut -d'"' -f4)"
  [ -n "$state" ] || return 0
  if [ "$state" = 'not-installed' ]; then
    warn_ '  The OCR runtime is not installed yet, so jobs cannot run.'
    dim_  '  Install it from the web UI (System / Settings). It downloads'
    dim_  "  several GB into $IMPRESSIVE_OCR_DATA_DIR/runtime."
    echo
  else
    dim_ "  OCR runtime: $state"
  fi
}

start_stack() {
  if port_busy "$API_PORT" || port_busy "$WEB_PORT"; then
    warn_ 'Already running. Use Stop first, or Restart.'
    return 0
  fi

  head_ 'Checking prerequisites'
  if ! check_prerequisites; then
    bad_ 'Cannot start until the items above are resolved.'
    return 1
  fi

  mkdir -p "$RUN_DIR" "$IMPRESSIVE_OCR_DATA_DIR"

  head_ 'Starting'
  dim_  "  data dir  $IMPRESSIVE_OCR_DATA_DIR"
  dim_  "  logs      $LOG_FILE"

  # stdin from /dev/null and both outputs into the log, so the child shares no descriptor
  # with this script. Without that, a caller piping us into another command (or into a
  # terminal that waits for EOF) hangs after we return: the pipe stays open as long as any
  # descendant holds its write end. `disown` then detaches it from this shell's job table.
  (
    cd "$REPO_ROOT" || exit 1
    nohup pnpm dev < /dev/null > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    disown 2>/dev/null || true
  )

  if wait_for_api; then
    echo
    good_ "  Web UI  http://localhost:$WEB_PORT"
    good_ "  API     http://127.0.0.1:$API_PORT"
    echo
    runtime_hint
  else
    bad_ "The API did not answer within 90s. Last lines of $LOG_FILE:"
    [ -f "$LOG_FILE" ] && tail -15 "$LOG_FILE" | sed 's/^/  /'
  fi
}

stop_stack() {
  local stopped=1

  if [ -f "$PID_FILE" ]; then
    local recorded
    recorded="$(tr -d '[:space:]' < "$PID_FILE")"
    if [ -n "$recorded" ] && kill -0 "$recorded" 2>/dev/null; then
      dim_ "  stopping pnpm (pid $recorded) and its children"
      kill_tree "$recorded"
      stopped=0
    fi
    rm -f "$PID_FILE"
  fi

  # Belt and braces: a crashed launcher, or a stack started by hand, leaves the ports held
  # by processes no pid file knows about.
  local port owner
  for port in "$API_PORT" "$WEB_PORT"; do
    while read -r owner; do
      [ -n "$owner" ] || continue
      dim_ "  freeing port $port (pid $owner)"
      kill_tree "$owner"
      stopped=0
    done < <(listener_pids "$port")
  done

  sleep 1
  if port_busy "$API_PORT" || port_busy "$WEB_PORT"; then
    bad_ 'Some processes survived; look for stray node processes.'
  elif [ $stopped -eq 0 ]; then
    good_ 'Stopped.'
  else
    dim_ 'Nothing was running.'
  fi
}

show_status() {
  head_ 'Status'
  local pids
  pids="$(listener_pids "$API_PORT" | tr '\n' ' ')"
  if [ -n "${pids// /}" ]; then good_ "  API     running  http://127.0.0.1:$API_PORT  (pid ${pids% })"
  else dim_ "  API     stopped  http://127.0.0.1:$API_PORT"; fi

  pids="$(listener_pids "$WEB_PORT" | tr '\n' ' ')"
  if [ -n "${pids// /}" ]; then good_ "  Web UI  running  http://localhost:$WEB_PORT  (pid ${pids% })"
  else dim_ "  Web UI  stopped  http://localhost:$WEB_PORT"; fi

  echo
  head_ 'Prerequisites'
  check_prerequisites || true

  if [ -f "$LOG_FILE" ]; then
    echo
    head_ "Last log lines ($LOG_FILE)"
    tail -8 "$LOG_FILE" | sed "s/^/  ${C_DIM}/;s/\$/${C_OFF}/"
  fi
}

show_environment() {
  local data_dir="$IMPRESSIVE_OCR_DATA_DIR"

  head_ 'Environment'
  rule_
  echo 'Only three variables are meant for you. Everything else with an'
  echo 'IMPRESSIVE_OCR_ prefix is injected by the server when it spawns the Python'
  echo 'sidecar - setting those by hand will confuse it.'
  echo

  head_ '  IMPRESSIVE_OCR_DATA_DIR'
  echo   "    now      $data_dir"
  dim_   '    default  %LOCALAPPDATA%\ImpressiveOCR on Windows, ~/.local/share/impressive-ocr elsewhere'
  dim_   '    This script defaults it next to the repo instead, because the OCR model'
  dim_   '    weights underneath it run to several GB.'
  echo

  head_ '  IMPRESSIVE_OCR_PORT'
  echo   "    now      $API_PORT"
  dim_   '    default  8084. Must be 1024-65535. The web dev server proxies /api to it,'
  dim_   '    so changing it also means changing BACKEND_PORT in apps/web/vite.config.ts.'
  echo

  head_ '  IMPRESSIVE_OCR_UV_BINARY'
  echo   "    now      ${IMPRESSIVE_OCR_UV_BINARY:-(unset)}"
  dim_   '    default  <repo>/vendor/uv-<arch>/uv[.exe]'
  dim_   '    uv builds the Python runtime. vendor/ is gitignored and fetched at build'
  dim_   '    time, so a fresh clone must supply it before the runtime can install.'
  echo

  rule_
  head_ 'What gets stored where'
  echo
  echo   "  $data_dir/"
  dim_   '    runtime/venv        Python interpreter and packages   ~2 GB'
  dim_   '    runtime/models      PaddleOCR weights                 ~1-4 GB, grows'
  dim_   '    runtime/uv-cache    uv download cache                 ~1 GB'
  dim_   '    impressive-ocr.db   job history and settings          small'
  dim_   '    logs/               server logs                       small'
  echo
  dim_   '  $TMPDIR/impressive-ocr-work   in-flight job scratch, safe to delete'
  dim_   "  $RUN_DIR   launcher pid and logs, safe to delete"
  echo
  warn_  '  Keep the data dir off a full drive. Nothing here is precious except'
  warn_  '  impressive-ocr.db; deleting the runtime just means installing it again.'
  echo

  rule_
  head_ 'Making it permanent'
  echo
  echo   '  Copy dev/dev.env.example to dev/dev.env and edit it. This script loads that'
  echo   '  file on every run, and dev.env is gitignored.'
  echo
  dim_   '  For your whole shell instead, add to ~/.bashrc:'
  dim_   '    export IMPRESSIVE_OCR_DATA_DIR=/d/ocr-data'
  echo
}

# ------------------------------------------------------------------- menu ----

show_header() {
  echo
  head_ '=============================================================='
  head_ ' Impressive OCR - development stack'
  head_ '=============================================================='
  dim_  "  repo      $REPO_ROOT"
  dim_  "  data dir  $IMPRESSIVE_OCR_DATA_DIR"

  if port_busy "$API_PORT"; then good_ "  API       http://127.0.0.1:$API_PORT   running"
  else dim_ "  API       http://127.0.0.1:$API_PORT   stopped"; fi

  if port_busy "$WEB_PORT"; then good_ "  Web UI    http://localhost:$WEB_PORT   running"
  else dim_ "  Web UI    http://localhost:$WEB_PORT   stopped"; fi

  rule_
}

show_menu() {
  local choice
  while true; do
    show_header
    echo '  1) Start'
    echo '  2) Stop'
    echo '  3) Restart'
    echo '  4) Status'
    echo '  5) Environment / where things are stored'
    echo '  6) Check / install prerequisites'
    echo '  Q) Quit'
    echo
    read -r -p '  Select: ' choice
    echo

    # Enter on its own redraws rather than scolding; see dev.ps1 for the reasoning.
    if [ -z "${choice//[[:space:]]/}" ]; then
      continue
    fi

    case "$(printf '%s' "$choice" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
      1) start_stack ;;
      2) stop_stack ;;
      3) stop_stack; sleep 1; start_stack ;;
      4) show_status ;;
      5) show_environment ;;
      6) install_prerequisites ;;
      q | quit | exit) return 0 ;;
      *) warn_ '  Not an option.' ;;
    esac

    echo
    dim_ '  Press Enter to continue...'
    read -r
  done
}

# ------------------------------------------------------------------- main ----

resolve_environment

case "${1:-menu}" in
  start)   start_stack ;;
  stop)    stop_stack ;;
  restart) stop_stack; sleep 1; start_stack ;;
  status)  show_status ;;
  env)     show_environment ;;
  doctor)  install_prerequisites ;;
  menu)    show_menu ;;
  *)       echo "usage: $0 [start|stop|restart|status|env|doctor]" >&2; exit 2 ;;
esac
