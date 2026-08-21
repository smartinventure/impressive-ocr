# SPDX-License-Identifier: AGPL-3.0-or-later
#
# What the development stack needs, whether this machine has it, and the exact command
# that fixes it. Sourced by dev.sh; not executable on its own.
#
# The required versions come from package.json ('engines.node' and 'packageManager') rather
# than being repeated here, because those are what CI and pnpm enforce.
#
# Kept to POSIX-ish bash without jq: this runs before dependencies are installed, so it may
# not assume any tool the repository would have provided.

# ------------------------------------------------------------- discovery ----

REQUIRED_NODE_FALLBACK='22.12.0'
REQUIRED_PNPM_FALLBACK='9.15.4'

required_node_version() {
  local found=''
  found="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"[^0-9]*\([0-9][0-9.]*\)".*/\1/p' \
    "$REPO_ROOT/package.json" 2>/dev/null | head -1)"
  printf '%s' "${found:-$REQUIRED_NODE_FALLBACK}"
}

required_pnpm_version() {
  local found=''
  found="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][0-9.]*\)".*/\1/p' \
    "$REPO_ROOT/package.json" 2>/dev/null | head -1)"
  printf '%s' "${found:-$REQUIRED_PNPM_FALLBACK}"
}

version_at_least() {
  # version_at_least FOUND REQUIRED. Compared field by field in awk rather than with
  # `sort -V`, which BSD sort did not always have.
  local found="${1#v}" required="$2"
  awk -v a="$found" -v b="$required" '
    BEGIN {
      na = split(a, x, /[.-]/); nb = split(b, y, /[.-]/);
      n = (na > nb ? na : nb);
      for (i = 1; i <= n; i++) {
        xi = (i <= na ? x[i] + 0 : 0); yi = (i <= nb ? y[i] + 0 : 0);
        if (xi > yi) exit 0;
        if (xi < yi) exit 1;
      }
      exit 0;
    }'
}

node_install_hint() {
  if is_windows; then
    if command -v winget >/dev/null 2>&1; then printf 'winget install OpenJS.NodeJS.LTS'
    else printf 'download the LTS installer from https://nodejs.org/'; fi
    return 0
  fi
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then printf 'brew install node'
      else printf 'install nvm (https://github.com/nvm-sh/nvm), then: nvm install --lts'; fi
      ;;
    *)
      printf 'install nvm (https://github.com/nvm-sh/nvm), then: nvm install --lts'
      ;;
  esac
}

uv_path() {
  local uv="${IMPRESSIVE_OCR_UV_BINARY:-}"
  if [ -z "$uv" ]; then
    if is_windows; then uv="$REPO_ROOT/vendor/uv/uv.exe"; else uv="$REPO_ROOT/vendor/uv/uv"; fi
  fi
  printf '%s' "$uv"
}

# ------------------------------------------------------------ the checks ----

# Each check is one line: NAME|STATE|DETAIL|FIX|AUTOFIX
#   STATE   ok | missing | outdated | warn      ('warn' does not block a start)
#   FIX     the command that repairs it, empty when there is none
#   AUTOFIX yes when option 6 may run FIX unattended
collect_prerequisites() {
  local want_node want_pnpm version uv
  want_node="$(required_node_version)"
  want_pnpm="$(required_pnpm_version)"

  if ! command -v node >/dev/null 2>&1; then
    printf 'node|missing|not on PATH (need %s or newer)|%s|no\n' "$want_node" "$(node_install_hint)"
  else
    version="$(node --version)"
    if version_at_least "$version" "$want_node"; then
      printf 'node|ok|%s||no\n' "$version"
    else
      printf 'node|outdated|%s, but this repo needs %s or newer|%s|no\n' \
        "$version" "$want_node" "$(node_install_hint)"
    fi
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    printf 'pnpm|missing|not on PATH|npm install -g pnpm@%s|yes\n' "$want_pnpm"
  else
    version="$(pnpm --version)"
    if version_at_least "$version" "$want_pnpm"; then
      printf 'pnpm|ok|%s||no\n' "$version"
    else
      # A pnpm older than the pin can resolve a different dependency tree than CI does.
      printf 'pnpm|outdated|%s, pinned at %s|npm install -g pnpm@%s|yes\n' \
        "$version" "$want_pnpm" "$want_pnpm"
    fi
  fi

  if [ -d "$REPO_ROOT/node_modules" ]; then
    printf 'deps|ok|installed||no\n'
  else
    printf 'deps|missing|node_modules is absent|pnpm install|yes\n'
  fi

  # uv only installs the OCR runtime; without it the stack still starts and the UI reports
  # the runtime as not installed. A warning, not a blocker.
  uv="$(uv_path)"
  if [ -f "$uv" ]; then
    printf 'uv|ok|%s||no\n' "$uv"
  else
    printf 'uv|warn|absent at %s - the OCR runtime cannot be installed|node deploy/fetch-uv.mjs|yes\n' "$uv"
  fi

  # PaddlePaddle publishes wheels for macosx_11_0_arm64, manylinux1_x86_64 and win_amd64
  # only. Apple Silicon is therefore fine; Linux on ARM and Windows on ARM are not, and on
  # Windows the x86-64 build under emulation dies during inference with no traceback at all.
  case "$(uname -s)/$(uname -m)" in
    Linux/aarch64 | Linux/arm64)
      printf 'cpu|warn|Linux on ARM has no PaddlePaddle wheel - OCR will not run||no\n' ;;
    Darwin/*) ;;
    *)
      if is_windows && printf '%s' "${PROCESSOR_IDENTIFIER:-}" | grep -qi 'arm'; then
        printf 'cpu|warn|Windows on ARM has no PaddlePaddle wheel - inference dies silently||no\n'
      fi
      ;;
  esac
}

field() { printf '%s' "$1" | cut -d'|' -f"$2"; }

check_prerequisites() {
  # Prints the checks; returns non-zero when something blocking is wrong. 'warn' items are
  # reported but do not block.
  local line name state detail fix blocked=0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="$(field "$line" 1)"; state="$(field "$line" 2)"
    detail="$(field "$line" 3)"; fix="$(field "$line" 4)"

    case "$state" in
      ok)   dim_  "$(printf '  %-6s%s' "$name" "$detail")" ;;
      warn) warn_ "$(printf '  %-6s%s' "$name" "$detail")" ;;
      *)    bad_  "$(printf '  %-6s%s' "$name" "$detail")"; blocked=1 ;;
    esac
    [ -n "$fix" ] && dim_ "          fix: $fix"
  done <<EOF
$(collect_prerequisites)
EOF

  if [ "$blocked" -ne 0 ]; then
    echo
    warn_ '  Menu option 6 installs what it safely can and prints the rest.'
  fi
  return "$blocked"
}

# --------------------------------------------------------------- repairs ----

run_fix() {
  local name="$1" fix="$2"
  head_ "  $name: $fix"
  case "$name" in
    pnpm) npm install -g "pnpm@$(required_pnpm_version)" ;;
    deps) (cd "$REPO_ROOT" && pnpm install) ;;
    uv)   (cd "$REPO_ROOT" && node deploy/fetch-uv.mjs) ;;
    *)    warn_ '  Nothing automatic for this one.' ;;
  esac
}

install_prerequisites() {
  # Runs what is safe to run unattended and prints the rest. A Node upgrade replaces a
  # system-wide interpreter, which is not something a dev launcher should do behind your back.
  local line name state detail fix auto manual='' automatic='' answer=''

  head_ 'Prerequisites'
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    state="$(field "$line" 2)"; fix="$(field "$line" 4)"
    [ "$state" = 'ok' ] && continue
    [ -n "$fix" ] || continue
    auto="$(field "$line" 5)"
    if [ "$auto" = 'yes' ]; then automatic="$automatic$line"$'\n'; else manual="$manual$line"$'\n'; fi
  done <<EOF
$(collect_prerequisites)
EOF

  if [ -z "$manual" ] && [ -z "$automatic" ]; then
    good_ '  Everything needed is present.'
    return 0
  fi

  if [ -n "$manual" ]; then
    echo
    warn_ '  Run these yourself - they change the machine, not the checkout:'
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      echo "    $(field "$line" 4)"
      dim_ "      ($(field "$line" 1): $(field "$line" 3))"
    done <<< "$manual"
    dim_ '    Then open a new shell, so PATH is picked up.'
  fi

  [ -n "$automatic" ] || return 0

  echo
  head_ '  These can be done now:'
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "    $(field "$line" 4)"
    dim_ "      ($(field "$line" 1): $(field "$line" 3))"
  done <<< "$automatic"
  echo

  # Without a terminal there is nobody to answer, so an unanswerable question means 'no'.
  if [ ! -t 0 ]; then
    dim_ '  Not an interactive shell, so nothing was run. The commands above are the whole fix.'
    return 0
  fi
  read -r -p '  Run them? [y/N]: ' answer
  case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    y | yes) ;;
    *) dim_ '  Left alone.'; return 0 ;;
  esac

  echo
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="$(field "$line" 1)"; fix="$(field "$line" 4)"
    run_fix "$name" "$fix"
  done <<< "$automatic"

  echo
  head_ 'Prerequisites now'
  check_prerequisites || true
}
