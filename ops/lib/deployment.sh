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
: "${RENTAL_DEPLOYMENT_RETENTION_FILE:=$RENTAL_OPS_STATE_DIR/deployment-retention.json}"
: "${RENTAL_RECONCILE_STATE_FILE:=$RENTAL_OPS_STATE_DIR/reconcile.json}"
# A dead service must be restarted, but a crash-looping one must not be
# restarted forever: three attempts an hour is enough to ride out a transient
# failure and few enough that a genuine crash loop reaches the alert quickly.
: "${RENTAL_RECONCILE_MAX_ATTEMPTS:=3}"
: "${RENTAL_RECONCILE_WINDOW_SECONDS:=3600}"

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

# Reports what the production container is actually doing. The deploy timer
# decides there is nothing to do by comparing digests, and without this it
# cannot tell a running service from one that exited hours ago.
deployment_container_state() {
  local state=""
  state=$(docker inspect \
    --format '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}{{else}}stopped{{end}}' \
    "$RENTAL_CONTAINER_NAME" 2>/dev/null) || state=missing
  printf '%s\n' "${state:-missing}"
}

# A container inside its healthcheck start period is not yet healthy, and
# restarting it for that alone would keep it from ever finishing starting.
deployment_service_is_live() {
  case $(deployment_container_state) in
    healthy | running | starting) return 0 ;;
    *) return 1 ;;
  esac
}

# Counts only the attempts still inside the window. Pruning by time rather
# than clearing on success is deliberate: a service that dies every twenty
# minutes must exhaust its budget instead of being restarted indefinitely.
deployment_reconcile_attempts() {
  local now=$1
  local cutoff=$((now - RENTAL_RECONCILE_WINDOW_SECONDS))
  local count=""
  if [[ -f $RENTAL_RECONCILE_STATE_FILE && ! -L $RENTAL_RECONCILE_STATE_FILE ]]; then
    count=$(jq --argjson cutoff "$cutoff" '
      [(.attempts // [])[] | select(type == "number" and . >= $cutoff)] | length
    ' "$RENTAL_RECONCILE_STATE_FILE" 2>/dev/null) || count=""
  fi
  [[ $count =~ ^[0-9]+$ ]] || count=0
  printf '%s\n' "$count"
}

deployment_record_reconcile_attempt() {
  local now=$1
  local cutoff=$((now - RENTAL_RECONCILE_WINDOW_SECONDS))
  local existing='{"attempts":[]}'
  local temporary
  install -d -m 0750 "$RENTAL_OPS_STATE_DIR"
  if [[ -f $RENTAL_RECONCILE_STATE_FILE && ! -L $RENTAL_RECONCILE_STATE_FILE ]]; then
    existing=$(jq -c . "$RENTAL_RECONCILE_STATE_FILE" 2>/dev/null) ||
      existing='{"attempts":[]}'
  fi
  temporary=$(mktemp "$RENTAL_OPS_STATE_DIR/.reconcile.XXXXXX")
  if ! jq --argjson now "$now" --argjson cutoff "$cutoff" '
    {
      schemaVersion: 1,
      attempts: (
        [(.attempts // [])[] | select(type == "number" and . >= $cutoff)] + [$now]
      )
    }
  ' <<<"$existing" >"$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0640 "$temporary"
  mv -f -- "$temporary" "$RENTAL_RECONCILE_STATE_FILE"
}

deployment_emit_reconcile() {
  local event=$1
  local result=$2
  local candidate=$3
  local state=$4
  local attempts=$5
  local priority=$6
  jq --compact-output --null-input \
    --arg event "$event" \
    --arg result "$result" \
    --arg candidate "$candidate" \
    --arg containerState "$state" \
    --argjson reconcileAttempts "$attempts" \
    '{
      event: $event,
      result: $result,
      candidateImage: $candidate,
      containerState: $containerState,
      reconcileAttempts: $reconcileAttempts
    }' |
    systemd-cat --identifier=rental-deploy --priority="$priority"
}

# The failure this exists for was never "nobody restarted the container". It
# was every operational surface reporting success while the bot was dead, so a
# spent budget has to be louder than the noop it replaces. The name matches the
# deployment_ prefix the monitor's deploy-unit alert reader accepts, which is
# what carries it into alert state without the application being alive.
deployment_emit_reconcile_alert() {
  local candidate=$1
  local state=$2
  local attempts=$3
  jq --compact-output --null-input \
    --arg candidate "$candidate" \
    --arg containerState "$state" \
    --argjson attempts "$attempts" \
    --argjson windowSeconds "$RENTAL_RECONCILE_WINDOW_SECONDS" \
    '{
      event: "alert.firing",
      alertName: "deployment_reconcile_exhausted",
      alertSeverity: "critical",
      candidateImage: $candidate,
      containerState: $containerState,
      attempts: $attempts,
      windowSeconds: $windowSeconds
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

deployment_extract_release_bundle() {
  local repository=$1
  local revision=$2
  local output_directory=$3
  local metadata_tag="$repository:metadata-$revision"
  local artifact container="" status=0
  install -d -m 0700 "$output_directory" || return
  docker pull "$metadata_tag" >/dev/null || return
  # Published metadata uses a scratch image with no default command. Supply an
  # inert path so Docker can create the stopped container used only by `cp`.
  container=$(
    docker create "$metadata_tag" /release/release-metadata.json
  ) || return
  for artifact in \
    release-metadata.json operations.tar compose.production.yaml package-lock.json; do
    docker cp "$container:/release/$artifact" "$output_directory/$artifact" ||
      status=1
  done
  docker rm "$container" >/dev/null 2>&1 || status=1
  ((status == 0)) || return 1
  jq -e . "$output_directory/release-metadata.json" >/dev/null || return
}

deployment_discard_staging_release() {
  local directory=$1
  [[ $directory == "$RENTAL_RELEASES_ROOT"/.release.* ]] || return 65
  [[ ! -L $directory ]] || return 65
  rm -rf -- "$directory"
}

deployment_set_release_permissions() {
  local directory=$1
  [[ $directory == "$RENTAL_RELEASES_ROOT"/* ]] || return 65
  [[ -d $directory && ! -L $directory ]] || return 65
  chgrp -R --no-dereference \
    --reference="$RENTAL_RELEASES_ROOT" "$directory" || return
  chmod -R g+rX,g-w,o-rwx "$directory"
}

deployment_validate_operations_archive() {
  local archive=$1
  local entry invalid_entry=0
  tar --list --file "$archive" >/dev/null || return 65
  while IFS= read -r entry; do
    case $entry in
      "" | /* | ../* | */../* | */..) invalid_entry=1 ;;
      # `git archive HEAD ops infra/systemd` includes the structural `infra/`
      # parent entry even though no files outside infra/systemd are archived.
      ops | ops/* | infra | infra/ | infra/systemd | infra/systemd/*) ;;
      *)
        invalid_entry=1
        ;;
    esac
  done < <(tar --list --file "$archive")
  if ((invalid_entry == 1)); then
    printf 'Operations bundle contains an unexpected path\n' >&2
    return 65
  fi
}

deployment_fetch_release() {
  local candidate=$1
  local revision=$2
  local metadata=$3
  local bundle_directory=$4
  local digest release_name final temporary
  digest=$(deployment_digest_hex "$candidate")
  release_name="$revision-${digest:0:16}"
  final="$RENTAL_RELEASES_ROOT/$release_name"
  if [[ -d $final && ! -L $final ]]; then
    [[ -f $final/compose.production.yaml &&
      -f $final/package-lock.json &&
      -f $final/release-metadata.json &&
      ! -L $final/release-metadata.json &&
      -d $final/ops &&
      -d $final/infra/systemd ]] || {
      printf 'Existing release directory is incomplete\n' >&2
      return 65
    }
    deployment_set_release_permissions "$final" || return 65
    printf '%s\n' "$final"
    return 0
  fi

  install -d -m 0750 "$RENTAL_RELEASES_ROOT" || return
  temporary=$(mktemp -d "$RENTAL_RELEASES_ROOT/.release.XXXXXX") || return
  if ! deployment_verify_release "$bundle_directory" "$candidate" "$metadata"; then
    deployment_discard_staging_release "$temporary"
    return 65
  fi
  install -m 0644 \
    "$bundle_directory/compose.production.yaml" \
    "$temporary/compose.production.yaml" || {
    deployment_discard_staging_release "$temporary"
    return 65
  }
  install -m 0644 \
    "$bundle_directory/package-lock.json" \
    "$temporary/package-lock.json" || {
    deployment_discard_staging_release "$temporary"
    return 65
  }
  install -m 0644 \
    "$metadata" \
    "$temporary/release-metadata.json" || {
    deployment_discard_staging_release "$temporary"
    return 65
  }
  if ! deployment_validate_operations_archive \
    "$bundle_directory/operations.tar"; then
    deployment_discard_staging_release "$temporary"
    return 65
  fi
  tar --extract --file "$bundle_directory/operations.tar" \
    --directory "$temporary" --no-same-owner || {
    deployment_discard_staging_release "$temporary"
    return 65
  }
  if [[ ! -d $temporary/ops || ! -d $temporary/infra/systemd ]]; then
    deployment_discard_staging_release "$temporary"
    return 65
  fi
  # Releases stay root-owned and immutable to the operator, but their active
  # rentalctl implementation and sourced libraries must be traversable and
  # readable by the same group that owns the releases root. Preserve owner
  # execute bits from the verified archive while granting only matching group
  # access and removing all access for other users.
  deployment_set_release_permissions "$temporary" || {
    deployment_discard_staging_release "$temporary"
    return 65
  }
  mv -T "$temporary" "$final" || {
    deployment_discard_staging_release "$temporary"
    return 65
  }
  printf '%s\n' "$final"
}

deployment_state_transition() {
  local previous_metadata=$1
  local candidate_metadata=$2
  local previous_image=$3
  local candidate_image=$4
  [[ -f $previous_metadata && ! -L $previous_metadata ]]
  [[ -f $candidate_metadata && ! -L $candidate_metadata ]]
  jq -e --arg image "$previous_image" '
    .schemaVersion == 2 and
    .imageReference == $image and
    (.sourceRevision | test("^[0-9a-f]{40}$")) and
    .stateBackend == "sqlite" and
    (.minimumStateSchema | type) == "number" and
    (.maximumStateSchema | type) == "number" and
    .minimumStateSchema >= 1 and
    .maximumStateSchema >= .minimumStateSchema and
    .minimumStateSchema == (.minimumStateSchema | floor) and
    .maximumStateSchema == (.maximumStateSchema | floor)
  ' "$previous_metadata" >/dev/null || {
    deployment_verification_error "current release declares $(
      deployment_describe_release_metadata "$previous_metadata"
    ), which is not a deployable state contract"
    return 65
  }
  jq -e --arg image "$candidate_image" '
    .schemaVersion == 2 and
    .imageReference == $image and
    .stateBackend == "sqlite" and
    (.minimumStateSchema | type) == "number" and
    (.maximumStateSchema | type) == "number" and
    .minimumStateSchema >= 1 and
    .maximumStateSchema >= .minimumStateSchema and
    .minimumStateSchema == (.minimumStateSchema | floor) and
    .maximumStateSchema == (.maximumStateSchema | floor)
  ' "$candidate_metadata" >/dev/null || {
    deployment_verification_error "candidate declares $(
      deployment_describe_release_metadata "$candidate_metadata"
    ), but a candidate must declare stateBackend sqlite with state schema 1 or higher"
    return 65
  }

  jq -e --slurpfile previous "$previous_metadata" '
    .minimumStateSchema <= $previous[0].minimumStateSchema and
    .maximumStateSchema >= $previous[0].maximumStateSchema
  ' "$candidate_metadata" >/dev/null || {
    printf 'Candidate does not support the previous SQLite schema range\n' >&2
    return 65
  }
  printf 'sqlite-to-sqlite\n'
}

# A refused candidate is the deployment's most common terminal state, and it
# is reached once every poll until someone intervenes. Naming the reason keeps
# a repeating alert from costing an operator a bisect to learn what the
# verifier wanted.
deployment_verification_error() {
  printf 'Release verification failed: %s\n' "$1" >&2
}

deployment_describe_release_metadata() {
  local metadata=$1
  jq -r '
    "schemaVersion \(.schemaVersion // "absent"), " +
    "image \(.imageReference // "absent"), " +
    "revision \(.sourceRevision // "absent"), " +
    "stateBackend \(.stateBackend // "absent"), " +
    "state schema \(.minimumStateSchema // "absent")-\(.maximumStateSchema // "absent")"
  ' "$metadata" 2>/dev/null ||
    printf 'unreadable or malformed release metadata'
}

# Verifies one candidate's own contract. The schema range is checked for shape
# only: whether a candidate covers the schema the host is actually serving is
# deployment_state_transition's rule, and pinning an exact range here would
# refuse every future migration until someone replaced this bundle by hand.
deployment_verify_release() {
  local bundle_directory=$1
  local candidate=$2
  local metadata=$3
  local compose_digest package_digest operations_digest label_digest
  jq -e \
    --arg image "$candidate" \
    --arg revision "$DEPLOYMENT_SOURCE_REVISION" \
    '.schemaVersion == 2 and
     .imageReference == $image and
     .imageDigest == ($image | split("@")[1]) and
     .sourceRevision == $revision and
     .stateBackend == "sqlite" and
     (.minimumStateSchema | type) == "number" and
     (.maximumStateSchema | type) == "number" and
     .minimumStateSchema >= 1 and
     .maximumStateSchema >= .minimumStateSchema and
     .minimumStateSchema == (.minimumStateSchema | floor) and
     .maximumStateSchema == (.maximumStateSchema | floor) and
     (.packageLockSha256 | test("^[0-9a-f]{64}$")) and
     (.composeSha256 | test("^[0-9a-f]{64}$")) and
     (.operationsBundleSha256 | test("^[0-9a-f]{64}$"))' \
    "$metadata" >/dev/null || {
    deployment_verification_error "candidate declares $(
      deployment_describe_release_metadata "$metadata"
    )"
    deployment_verification_error \
      "this release deploys schemaVersion 2, image $candidate, revision $DEPLOYMENT_SOURCE_REVISION, stateBackend sqlite, state schema 1 or higher"
    return 65
  }
  compose_digest=$(
    sha256sum "$bundle_directory/compose.production.yaml" | awk '{print $1}'
  ) || {
    deployment_verification_error 'compose.production.yaml is unreadable'
    return 65
  }
  test "$compose_digest" = "$(jq -r .composeSha256 "$metadata")" || {
    deployment_verification_error \
      "compose.production.yaml digest $compose_digest does not match the metadata"
    return 65
  }
  package_digest=$(
    sha256sum "$bundle_directory/package-lock.json" | awk '{print $1}'
  ) || {
    deployment_verification_error 'package-lock.json is unreadable'
    return 65
  }
  test "$package_digest" = "$(jq -r .packageLockSha256 "$metadata")" || {
    deployment_verification_error \
      "package-lock.json digest $package_digest does not match the metadata"
    return 65
  }
  label_digest=$(
    docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.package-lock.sha256"}}' \
      "$candidate"
  ) || {
    deployment_verification_error "candidate image $candidate cannot be inspected"
    return 65
  }
  test "$package_digest" = "$label_digest" || {
    deployment_verification_error \
      "candidate image declares package-lock digest $label_digest but the bundle carries $package_digest"
    return 65
  }
  operations_digest=$(
    sha256sum "$bundle_directory/operations.tar" | awk '{print $1}'
  ) || {
    deployment_verification_error 'operations.tar is unreadable'
    return 65
  }
  test "$operations_digest" = "$(jq -r .operationsBundleSha256 "$metadata")" || {
    deployment_verification_error \
      "operations.tar digest $operations_digest does not match the metadata"
    return 65
  }
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
        $bot.cap_add == ["SYS_ADMIN"] and
        $bot.deploy.replicas == 1 and
        $bot.deploy.update_config.order == "stop-first" and
        (($bot.ports // []) | length == 0) and
        ([ $bot.volumes[] | select(.target == "/app/.data") ] | length == 1) and
        ([ $bot.volumes[] | select(.target == "/app-backups") ] | length == 1)
    ' >/dev/null
}

deployment_validate_first_install_storage() {
  local identity mountpoint profile unexpected
  if ! docker volume inspect rental-apartments-data >/dev/null 2>&1; then
    docker volume create \
      --driver local \
      --label com.docker.compose.project=rental-apartments \
      --label com.docker.compose.volume=rental-apartments-data \
      rental-apartments-data >/dev/null
  fi
  identity=$(
    docker volume inspect \
      --format '{{.Name}}|{{.Driver}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}' \
      rental-apartments-data
  )
  [[ $identity == \
    "rental-apartments-data|local|rental-apartments|rental-apartments-data" ]] || {
    printf 'Application data volume does not match the production identity\n' >&2
    return 65
  }
  mountpoint=$(
    docker volume inspect --format '{{.Mountpoint}}' rental-apartments-data
  )
  ops_require_absolute_path "data volume mountpoint" "$mountpoint"
  [[ -d $mountpoint && ! -L $mountpoint ]]

  # A failed first candidate can legitimately leave the dedicated Chrome
  # identity behind for operator verification. No application state is allowed
  # until a release has passed the complete first-install gate.
  if [[ -z $(find "$mountpoint" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
    return
  fi
  profile="$mountpoint/chrome-profile"
  unexpected=$(
    find "$mountpoint" \
      -mindepth 1 -maxdepth 1 ! -name chrome-profile -print -quit
  )
  [[ -z $unexpected && -d $profile && ! -L $profile ]] || {
    printf 'First deployment requires empty or browser-profile-only application storage\n' >&2
    return 65
  }
}

# A first installation creates its own empty database before launching the
# candidate, so a rejected candidate has to leave the volume as it found it.
# Without this the storage gate above refuses every later attempt, including the
# browser-verification retry it deliberately allows for.
deployment_clear_first_install_state() {
  local mountpoint
  mountpoint=$(
    docker volume inspect --format '{{.Mountpoint}}' rental-apartments-data
  ) || return 0
  ops_require_absolute_path "data volume mountpoint" "$mountpoint" || return 0
  [[ -d $mountpoint && ! -L $mountpoint ]] || return 0
  rm -f \
    "$mountpoint/state.sqlite3" \
    "$mountpoint/state.sqlite3-wal" \
    "$mountpoint/state.sqlite3-shm"
}

deployment_wait_candidate() {
  local started_epoch=$1
  local observation_seconds=$2
  local expected_channel=$3
  local records
  ops_wait_ready || return $?
  sleep "$observation_seconds"
  ops_wait_ready || return $?
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
  local target="$RENTAL_DEPLOYMENT_RETENTION_FILE"
  local temporary
  temporary=$(mktemp "$RENTAL_OPS_STATE_DIR/.retention.XXXXXX")
  if [[ -f $target ]]; then
    jq --slurpfile release "$evidence_file" '
      .schemaVersion = 2 |
      .protectedReleases = (.protectedReleases // []) |
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
      '{
        schemaVersion: 2,
        minimumRetainedReleases: 3,
        retainedReleases: [$release[0]],
        protectedReleases: []
      }' \
      >"$temporary"
  fi
  chmod 0600 "$temporary"
  mv -f "$temporary" "$target"
}

# Releases the protected pre-SQLite rollback point and prints the snapshot it
# released. Nothing can take a new one: this release reads state only from
# SQLite, so a protected snapshot and the bridge image pinned beside it are
# retired evidence, and this is the only way to stop retention pinning them.
# The caller must name the image it believes is protected: clearing the entry
# unread would discard the record of what was retired.
deployment_unprotect_migration_release() {
  local expected_image=$1
  local target="$RENTAL_DEPLOYMENT_RETENTION_FILE"
  local temporary snapshot
  [[ -f $target && ! -L $target ]]
  snapshot=$(jq -er --arg image "$expected_image" '
    select(
      (.protectedReleases | length) == 1 and
      .protectedReleases[0].candidateImage == $image
    ) |
    .protectedReleases[0].protectedSnapshot
  ' "$target") || {
    printf 'No single protected rollback point is registered for %s\n' \
      "$expected_image" >&2
    return 65
  }
  [[ $snapshot == "$RENTAL_BACKUP_ROOT"/protected/pre-sqlite-* ]] || {
    printf 'Protected snapshot is outside the protected backup directory\n' >&2
    return 65
  }
  temporary=$(mktemp "$RENTAL_OPS_STATE_DIR/.retention.XXXXXX")
  if ! jq '.schemaVersion = 2 | .protectedReleases = []' \
    "$target" >"$temporary"; then
    rm -- "$temporary"
    return 65
  fi
  chmod 0600 "$temporary"
  mv -f "$temporary" "$target"
  printf '%s\n' "$snapshot"
}
