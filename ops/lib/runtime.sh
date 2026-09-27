#!/usr/bin/env bash
# The operations library consumes these command and Compose option arrays.
# shellcheck disable=SC2034
# Every retained deployable image has an explicit Rust runtime label.
ops_runtime() {
  local label
  label=$("${DOCKER_BIN:-docker}" inspect --format='{{index .Config.Labels "com.rental-apartments.runtime"}}' "$1") || return
  case "$label" in
    rust) printf 'rust\n' ;;
    *) printf 'Unsupported application runtime label: %s\n' "$label" >&2; return 65 ;;
  esac
}

ops_app_command() {
  local image="$1" action="$2"
  shift 2
  ops_runtime "$image" >/dev/null || return
  OPS_APP_COMMAND=()
  case "$action" in
    initialize) OPS_APP_COMMAND=(state:init) ;;
    backup) OPS_APP_COMMAND=(backup:create) ;;
    validate|restore) OPS_APP_COMMAND=("backup:$action" --snapshot "$1") ;;
    maintenance) OPS_APP_COMMAND=(maintenance:report) ;;
    disk-check) OPS_APP_COMMAND=(storage:check) ;;
    health) OPS_APP_COMMAND=(/usr/local/bin/rental-app health-check "$@") ;;
    browser-cleanup) OPS_APP_COMMAND=(browser:cleanup "$@") ;;
    *) printf 'Unsupported native operation: %s\n' "$action" >&2; return 65 ;;
  esac
}

ops_image_file_reference() {
  local line reference='' count=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      RENTAL_APARTMENTS_IMAGE=*) reference="${line#RENTAL_APARTMENTS_IMAGE=}"; count="$((count+1))" ;;
      ''|\#*) ;;
      *) return 65 ;;
    esac
  done <"$1"
  [[ "$count" == 1 && "$reference" =~ ^[a-zA-Z0-9._/:@-]+@sha256:[0-9a-f]{64}$ ]] || return 65
  printf '%s\n' "$reference"
}

ops_runtime_compose_options() {
  local release="$1" image="$2"
  ops_runtime "$image" >/dev/null || return
  OPS_RUNTIME_COMPOSE_OPTIONS=()
  [[ -f "$release/ops/compose.native.yaml" && ! -L "$release/ops/compose.native.yaml" ]] || {
    printf 'Native image requires its bundled Compose override\n' >&2; return 65;
  }
  OPS_RUNTIME_COMPOSE_OPTIONS=(--file "$release/ops/compose.native.yaml")
}
