#!/usr/bin/env bash

# shellcheck source=ops/lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

: "${RENTAL_OPS_STATE_DIR:=/var/lib/rental-apartments-ops}"
: "${RENTAL_OPS_LOCK_FILE:=$RENTAL_OPS_STATE_DIR/operations.lock}"
: "${RENTAL_OPS_LOCK_WAIT_SECONDS:=0}"
: "${RENTAL_RELEASE_DIR:=/opt/rental-apartments/current}"
: "${RENTAL_COMPOSE_FILE:=$RENTAL_RELEASE_DIR/compose.production.yaml}"
: "${RENTAL_ENV_FILE:=/etc/rental-apartments/env}"
: "${RENTAL_IMAGE_ENV_FILE:=$RENTAL_OPS_STATE_DIR/current-image.env}"
: "${RENTAL_BACKUP_ROOT:=/mnt/rental-apartments-backups}"
: "${RENTAL_BACKUP_VOLUME:=rental-apartments-backups}"
: "${RENTAL_REQUIRE_BACKUP_MOUNT:=1}"
: "${RENTAL_APP_SERVICE:=rental-apartments.service}"
: "${RENTAL_CONTAINER_NAME:=rental-apartments-bot}"
: "${RENTAL_READY_ATTEMPTS:=20}"
: "${RENTAL_READY_INTERVAL_SECONDS:=3}"

ops_validate_runtime_contract() {
  ops_require_absolute_path "RENTAL_RELEASE_DIR" "$RENTAL_RELEASE_DIR"
  ops_require_absolute_path "RENTAL_COMPOSE_FILE" "$RENTAL_COMPOSE_FILE"
  ops_require_absolute_path "RENTAL_ENV_FILE" "$RENTAL_ENV_FILE"
  ops_require_absolute_path "RENTAL_IMAGE_ENV_FILE" "$RENTAL_IMAGE_ENV_FILE"
  [[ -d $RENTAL_RELEASE_DIR ]]
  [[ -f $RENTAL_COMPOSE_FILE && ! -L $RENTAL_COMPOSE_FILE ]]
  [[ -f $RENTAL_ENV_FILE && ! -L $RENTAL_ENV_FILE ]]
  [[ -f $RENTAL_IMAGE_ENV_FILE && ! -L $RENTAL_IMAGE_ENV_FILE ]]
}

ops_require_backup_mount() {
  ops_require_absolute_path "RENTAL_BACKUP_ROOT" "$RENTAL_BACKUP_ROOT"
  [[ -d $RENTAL_BACKUP_ROOT && ! -L $RENTAL_BACKUP_ROOT ]]
  if ((RENTAL_REQUIRE_BACKUP_MOUNT != 0)); then
    mountpoint --quiet -- "$RENTAL_BACKUP_ROOT"
  fi
}

ops_read_image_reference() {
  local line image="" count=0
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      RENTAL_APARTMENTS_IMAGE=*)
        image=${line#RENTAL_APARTMENTS_IMAGE=}
        count=$((count + 1))
        ;;
      "" | \#*) ;;
      *)
        printf 'Unexpected key in current image record\n' >&2
        return 65
        ;;
    esac
  done <"$RENTAL_IMAGE_ENV_FILE"
  if ((count != 1)) ||
    [[ ! $image =~ ^[a-zA-Z0-9._/:@-]+@sha256:[0-9a-f]{64}$ ]]; then
    printf 'Current image record is not one immutable digest\n' >&2
    return 65
  fi
  printf '%s\n' "$image"
}

ops_compose() {
  docker compose \
    --project-name rental-apartments \
    --project-directory "$RENTAL_RELEASE_DIR" \
    --env-file "$RENTAL_IMAGE_ENV_FILE" \
    --env-file "$RENTAL_ENV_FILE" \
    --file "$RENTAL_COMPOSE_FILE" \
    "$@"
}

ops_wait_ready() {
  local attempt status
  for ((attempt = 1; attempt <= RENTAL_READY_ATTEMPTS; attempt += 1)); do
    status=$(
      docker inspect \
        --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
        "$RENTAL_CONTAINER_NAME" 2>/dev/null
    ) || status=missing
    if [[ $status == healthy ]]; then
      return 0
    fi
    if ((attempt < RENTAL_READY_ATTEMPTS)); then
      sleep "$RENTAL_READY_INTERVAL_SECONDS"
    fi
  done
  printf 'Application did not become ready\n' >&2
  return 70
}

ops_stop_application() {
  systemctl stop "$RENTAL_APP_SERVICE"
}

ops_start_application() {
  local start_status=0
  systemctl start "$RENTAL_APP_SERVICE" || start_status=$?
  if ((start_status != 0)); then
    return "$start_status"
  fi
  ops_wait_ready
}

ops_latest_snapshot() {
  local daily candidate latest="" name
  daily=$RENTAL_BACKUP_ROOT/daily
  ops_require_absolute_path "RENTAL_BACKUP_ROOT" "$RENTAL_BACKUP_ROOT"
  [[ -d $daily && ! -L $daily ]]
  shopt -s nullglob
  for candidate in "$daily"/*; do
    [[ -d $candidate && ! -L $candidate ]] || continue
    name=${candidate##*/}
    [[ $name =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9TZ.-]+$ ]] || continue
    if [[ -z $latest || $name > ${latest##*/} ]]; then
      latest=$candidate
    fi
  done
  shopt -u nullglob
  [[ -n $latest ]] || {
    printf 'No published daily snapshot exists\n' >&2
    return 66
  }
  printf '%s\n' "$latest"
}

ops_latest_protected_snapshot() {
  local protected candidate latest="" name
  protected=$RENTAL_BACKUP_ROOT/protected
  ops_require_absolute_path "RENTAL_BACKUP_ROOT" "$RENTAL_BACKUP_ROOT"
  [[ -d $protected && ! -L $protected ]]
  shopt -s nullglob
  for candidate in "$protected"/pre-sqlite-*; do
    [[ -d $candidate && ! -L $candidate ]] || continue
    name=${candidate##*/}
    [[ $name =~ ^pre-sqlite-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9TZ.-]+$ ]] ||
      continue
    if [[ -z $latest || $name > ${latest##*/} ]]; then
      latest=$candidate
    fi
  done
  shopt -u nullglob
  [[ -n $latest ]] || {
    printf 'No protected pre-SQLite snapshot exists\n' >&2
    return 66
  }
  printf '%s\n' "$latest"
}

ops_snapshot_container_path() {
  local snapshot=$1
  local resolved_root resolved_snapshot
  resolved_root=$(realpath -- "$RENTAL_BACKUP_ROOT")
  resolved_snapshot=$(realpath -- "$snapshot")
  case $resolved_snapshot in
    "$resolved_root"/daily/*)
      printf '/app-backups/daily/%s\n' "${resolved_snapshot##*/}"
      ;;
    "$resolved_root"/protected/pre-sqlite-*)
      printf '/app-backups/protected/%s\n' "${resolved_snapshot##*/}"
      ;;
    *)
      printf 'Snapshot is outside the supported backup directories\n' >&2
      return 65
      ;;
  esac
}

ops_validate_snapshot() {
  local snapshot=$1
  local container_path
  container_path=$(ops_snapshot_container_path "$snapshot")
  ops_compose run --rm --no-deps bot \
    node src/recovery-cli.js validate "$container_path"
}
