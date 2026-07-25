#!/usr/bin/env bash

# Digest discovery, release verification, and sanitized deployment state.
# This library deliberately never sources the production environment file:
# credentials may contain shell syntax and must only travel to docker login on
# stdin or to Compose through --env-file.

: "${RENTAL_RELEASES_ROOT:=/var/lib/rental-apartments/releases}"
: "${RENTAL_DEPLOYMENTS_DIR:=$RENTAL_OPS_STATE_DIR/deployments}"
: "${RENTAL_QUARANTINE_DIR:=$RENTAL_OPS_STATE_DIR/quarantine}"
: "${RENTAL_CURRENT_LINK:=/opt/rental-apartments/current}"
: "${RENTAL_MINIMUM_FREE_KB:=1048576}"
: "${RENTAL_GIT_REMOTE:=}"

deployment_validate_actor() {
  local actor=$1
  [[ ${#actor} -ge 3 ]] &&
    [[ ! $actor =~ ^(unknown|n/a|none|operator|actor|automation|systemd|github-actions)$ ]]
}

deployment_validate_digest_reference() {
  [[ $1 =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]]
}

deployment_digest_hex() {
  printf '%s\n' "${1##*@sha256:}"
}

deployment_read_setting() {
  local key=$1
  local line value="" count=0
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      "$key="*)
        value=${line#*=}
        count=$((count + 1))
        ;;
    esac
  done <"$RENTAL_ENV_FILE"
  if ((count != 1)) || [[ -z $value || $value == *$'\r'* ]]; then
    printf 'Required production setting is missing or repeated: %s\n' "$key" >&2
    return 65
  fi
  printf '%s\n' "$value"
}

deployment_read_optional_setting() {
  local key=$1
  local line value="" count=0
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      "$key="*)
        value=${line#*=}
        count=$((count + 1))
        ;;
    esac
  done <"$RENTAL_ENV_FILE"
  ((count <= 1)) || {
    printf 'Optional production setting is repeated: %s\n' "$key" >&2
    return 65
  }
  printf '%s\n' "$value"
}

deployment_emit() {
  local event=$1
  local result=$2
  local candidate=${3:-}
  local previous=${4:-}
  jq --compact-output --null-input \
    --arg event "$event" \
    --arg result "$result" \
    --arg candidate "$candidate" \
    --arg previous "$previous" \
    '{
      event: $event,
      result: $result,
      candidateImage: (if $candidate == "" then null else $candidate end),
      previousImage: (if $previous == "" then null else $previous end)
    }' |
    systemd-cat --identifier=rental-deploy --priority=info
}

deployment_emit_alert() {
  local candidate=$1
  local previous=$2
  jq --compact-output --null-input \
    --arg candidate "$candidate" \
    --arg previous "$previous" \
    '{
      event: "alert.firing",
      alertName: "deployment_failure",
      alertSeverity: "critical",
      candidateImage: $candidate,
      previousImage: $previous
    }' |
    systemd-cat --identifier=rental-deploy --priority=warning
}

deployment_quarantine_file() {
  local digest
  digest=$(deployment_digest_hex "$1")
  printf '%s/%s.json\n' "$RENTAL_QUARANTINE_DIR" "$digest"
}

deployment_is_quarantined() {
  [[ -f $(deployment_quarantine_file "$1") ]]
}

deployment_write_quarantine() {
  local candidate=$1
  local revision=$2
  local reason=$3
  local file temporary
  install -d -m 0700 "$RENTAL_QUARANTINE_DIR"
  file=$(deployment_quarantine_file "$candidate")
  [[ ! -e $file ]] || return 0
  temporary=$(mktemp "$RENTAL_QUARANTINE_DIR/.quarantine.XXXXXX")
  chmod 0600 "$temporary"
  jq --null-input \
    --arg candidateImage "$candidate" \
    --arg sourceRevision "$revision" \
    --arg reason "$reason" \
    --arg recordedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      schemaVersion: 1,
      candidateImage: $candidateImage,
      sourceRevision: (if $sourceRevision == "" then null else $sourceRevision end),
      reason: $reason,
      recordedAt: $recordedAt
    }' >"$temporary"
  if ! ln "$temporary" "$file"; then
    rm -- "$temporary"
    return 1
  fi
  rm -- "$temporary"
}

deployment_clear_quarantine() {
  local candidate=$1
  local file
  deployment_validate_digest_reference "$candidate" || return 64
  file=$(deployment_quarantine_file "$candidate")
  if [[ -e $file ]]; then
    [[ -f $file && ! -L $file && $file == "$RENTAL_QUARANTINE_DIR"/* ]] ||
      return 65
    rm -- "$file"
  fi
}

deployment_compose() {
  local release_directory=$1
  local image_environment=$2
  shift 2
  docker compose \
    --project-name rental-apartments \
    --project-directory "$release_directory" \
    --env-file "$image_environment" \
    --env-file "$RENTAL_ENV_FILE" \
    --file "$release_directory/compose.production.yaml" \
    "$@"
}

deployment_write_image_environment() {
  local target=$1
  local reference=$2
  local directory temporary
  deployment_validate_digest_reference "$reference" || return 65
  directory=$(dirname -- "$target")
  install -d -m 0700 "$directory"
  temporary=$(mktemp "$directory/.current-image.XXXXXX")
  chmod 0600 "$temporary"
  printf 'RENTAL_APARTMENTS_IMAGE=%s\n' "$reference" >"$temporary"
  mv -f "$temporary" "$target"
}

deployment_resolve_discovery() {
  local repository=$1
  local discovery="$repository:production"
  local reference
  docker pull "$discovery" >/dev/null
  while IFS= read -r reference; do
    if [[ $reference == "$repository"@sha256:* ]] &&
      deployment_validate_digest_reference "$reference"; then
      printf '%s\n' "$reference"
      return 0
    fi
  done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$discovery")
  printf 'Production discovery tag did not resolve to one immutable digest\n' >&2
  return 65
}

deployment_extract_metadata() {
  local repository=$1
  local revision=$2
  local output=$3
  local metadata_tag="$repository:metadata-$revision"
  local container=""
  docker pull "$metadata_tag" >/dev/null
  container=$(docker create "$metadata_tag")
  if ! docker cp "$container:/release-metadata.json" "$output"; then
    docker rm "$container" >/dev/null 2>&1 || true
    return 1
  fi
  docker rm "$container" >/dev/null
  jq -e . "$output" >/dev/null
}

deployment_fetch_release() {
  local repository=$1
  local candidate=$2
  local revision=$3
  local metadata=$4
  local digest release_name final temporary remote
  digest=$(deployment_digest_hex "$candidate")
  release_name="$revision-${digest:0:16}"
  final="$RENTAL_RELEASES_ROOT/$release_name"
  if [[ -d $final && ! -L $final ]]; then
    printf '%s\n' "$final"
    return 0
  fi

  install -d -m 0750 "$RENTAL_RELEASES_ROOT"
  temporary=$(mktemp -d "$RENTAL_RELEASES_ROOT/.release.XXXXXX")
  remote=$RENTAL_GIT_REMOTE
  if [[ -z $remote ]]; then
    remote="https://github.com/${repository#ghcr.io/}.git"
  fi
  git -C "$temporary" init --quiet
  git -C "$temporary" remote add origin "$remote"
  git -C "$temporary" fetch --quiet --depth=1 origin "$revision"
  git -C "$temporary" checkout --quiet --detach FETCH_HEAD
  test "$(git -C "$temporary" rev-parse HEAD)" = "$revision"
  deployment_verify_release "$temporary" "$candidate" "$metadata"
  mv -T "$temporary" "$final"
  printf '%s\n' "$final"
}

deployment_verify_release() {
  local release_directory=$1
  local candidate=$2
  local metadata=$3
  local compose_digest package_digest operations_archive operations_digest
  jq -e \
    --arg image "$candidate" \
    --arg revision "$DEPLOYMENT_SOURCE_REVISION" \
    '.schemaVersion == 2 and
     .imageReference == $image and
     .imageDigest == ($image | split("@")[1]) and
     .sourceRevision == $revision and
     (.packageLockSha256 | test("^[0-9a-f]{64}$")) and
     (.composeSha256 | test("^[0-9a-f]{64}$")) and
     (.operationsBundleSha256 | test("^[0-9a-f]{64}$"))' \
    "$metadata" >/dev/null
  compose_digest=$(sha256sum "$release_directory/compose.production.yaml" | awk '{print $1}')
  test "$compose_digest" = "$(jq -r .composeSha256 "$metadata")"
  package_digest=$(sha256sum "$release_directory/package-lock.json" | awk '{print $1}')
  test "$package_digest" = "$(jq -r .packageLockSha256 "$metadata")"
  test "$package_digest" = "$(
    docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.package-lock.sha256"}}' \
      "$candidate"
  )"
  operations_archive=$(mktemp "$RENTAL_OPS_STATE_DIR/.operations.XXXXXX")
  git -C "$release_directory" archive --format=tar HEAD ops infra/systemd >"$operations_archive"
  operations_digest=$(sha256sum "$operations_archive" | awk '{print $1}')
  rm -- "$operations_archive"
  test "$operations_digest" = "$(jq -r .operationsBundleSha256 "$metadata")"
}

deployment_validate_compose() {
  local release_directory=$1
  local image_environment=$2
  deployment_compose "$release_directory" "$image_environment" config --format json |
    jq -e '
      .services.bot as $bot
      | $bot.container_name == "rental-apartments-bot" and
        $bot.labels["com.rental-apartments.environment"] == "production" and
        $bot.environment.NODE_ENV == "production" and
        $bot.read_only == true and
        $bot.deploy.replicas == 1 and
        $bot.deploy.update_config.order == "stop-first" and
        (($bot.ports // []) | length == 0) and
        ([ $bot.volumes[] | select(.target == "/app/.data") ] | length == 1) and
        ([ $bot.volumes[] | select(.target == "/app-backups") ] | length == 1)
    ' >/dev/null
}

deployment_validate_empty_storage() {
  local mountpoint
  mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' rental-apartments-data)
  ops_require_absolute_path "data volume mountpoint" "$mountpoint"
  [[ -d $mountpoint && ! -L $mountpoint ]]
  [[ -z $(find "$mountpoint" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
    printf 'First deployment requires an empty application data volume\n' >&2
    return 65
  }
}

deployment_wait_candidate() {
  local started_epoch=$1
  local observation_seconds=$2
  local expected_channel=$3
  local records
  ops_wait_ready
  sleep "$observation_seconds"
  ops_wait_ready
  records=$(journalctl \
    --no-pager \
    --quiet \
    --output=cat \
    --since "@$started_epoch" \
    "CONTAINER_NAME=$RENTAL_CONTAINER_NAME")
  jq -Rse --arg expectedChannel "$expected_channel" '
    split("\n")
    | map(fromjson? | select(type == "object")) as $records
    | any($records[];
        .event == "startup.preflight.completed" and
        .preflight.status == "ready" and
        .preflight.checks.telegram == "passed" and
        .preflight.checks.channel == $expectedChannel) and
      any($records[]; .event == "crawl.succeeded")
  ' <<<"$records" >/dev/null
}

deployment_switch_current() {
  local release_directory=$1
  local candidate=$2
  local temporary_link="$RENTAL_CURRENT_LINK.next"
  [[ $release_directory == "$RENTAL_RELEASES_ROOT"/* && -d $release_directory ]]
  ops_require_absolute_path "RENTAL_CURRENT_LINK" "$RENTAL_CURRENT_LINK"
  if [[ -e $temporary_link || -L $temporary_link ]]; then
    rm -- "$temporary_link"
  fi
  ln -s "$release_directory" "$temporary_link"
  mv -T "$temporary_link" "$RENTAL_CURRENT_LINK"
  deployment_write_image_environment "$RENTAL_IMAGE_ENV_FILE" "$candidate"
}

deployment_restore_current() {
  local release_directory=$1
  local image=$2
  deployment_switch_current "$release_directory" "$image"
}

deployment_clear_first_install_current() {
  local release_directory=$1
  local candidate=$2
  local current_target=""
  if [[ -L $RENTAL_CURRENT_LINK ]]; then
    current_target=$(readlink -f "$RENTAL_CURRENT_LINK")
    if [[ $current_target == "$release_directory" ]]; then
      rm -- "$RENTAL_CURRENT_LINK"
    fi
  fi
  if [[ -f $RENTAL_IMAGE_ENV_FILE ]] &&
    [[ $(ops_read_image_reference) == "$candidate" ]]; then
    rm -- "$RENTAL_IMAGE_ENV_FILE"
  fi
}

deployment_write_evidence() {
  local outcome=$1
  local actor=$2
  local candidate=$3
  local previous=$4
  local revision=$5
  local snapshot=$6
  local first_install=$7
  local rollback_result=$8
  local release_directory=$9
  local digest timestamp file temporary
  digest=$(deployment_digest_hex "$candidate")
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  install -d -m 0700 "$RENTAL_DEPLOYMENTS_DIR"
  file="$RENTAL_DEPLOYMENTS_DIR/$timestamp-$outcome-${digest:0:16}.json"
  temporary=$(mktemp "$RENTAL_DEPLOYMENTS_DIR/.evidence.XXXXXX")
  chmod 0600 "$temporary"
  jq --null-input \
    --arg outcome "$outcome" \
    --arg actor "$actor" \
    --arg candidateImage "$candidate" \
    --arg previousImage "$previous" \
    --arg sourceRevision "$revision" \
    --arg releaseDirectory "$release_directory" \
    --arg snapshot "$snapshot" \
    --argjson firstInstall "$first_install" \
    --arg rollbackResult "$rollback_result" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      schemaVersion: 1,
      outcome: $outcome,
      actor: $actor,
      candidateImage: $candidateImage,
      previousImage: (if $previousImage == "" then null else $previousImage end),
      sourceRevision: $sourceRevision,
      releaseDirectory: (if $releaseDirectory == "" then null else $releaseDirectory end),
      snapshot: (if $snapshot == "" then null else $snapshot end),
      firstInstall: $firstInstall,
      rollback: {
        attempted: ($rollbackResult != "not-applicable"),
        result: $rollbackResult
      },
      completedAt: $completedAt
    }' >"$temporary"
  mv -f "$temporary" "$file"
  printf '%s\n' "$file"
}

deployment_update_retention_index() {
  local evidence_file=$1
  local target="$RENTAL_OPS_STATE_DIR/deployment-retention.json"
  local temporary
  temporary=$(mktemp "$RENTAL_OPS_STATE_DIR/.retention.XXXXXX")
  if [[ -f $target ]]; then
    jq --slurpfile release "$evidence_file" '
      .retainedReleases = (
        reduce ([$release[0]] + (.retainedReleases // []))[] as $item
          ([];
           if any(.[]; .candidateImage == $item.candidateImage)
           then .
           else . + [$item]
           end)
        | .[0:3]
      )
    ' "$target" >"$temporary"
  else
    jq --null-input --slurpfile release "$evidence_file" \
      '{schemaVersion: 1, minimumRetainedReleases: 3, retainedReleases: [$release[0]]}' \
      >"$temporary"
  fi
  chmod 0600 "$temporary"
  mv -f "$temporary" "$target"
}
