#!/usr/bin/env bash

# Docker image retention is derived from the same deployment index used for
# rollback. Broad Docker prune commands cannot preserve that application-level
# relationship, so this library inventories and removes only explicit IDs.

: "${RENTAL_DEPLOYMENT_RETENTION_FILE:=$RENTAL_OPS_STATE_DIR/deployment-retention.json}"
: "${RENTAL_IMAGE_RETENTION_COUNT:=3}"
: "${RENTAL_IMAGE_TITLE:=rental-apartments-bot}"

image_retention_validate_digest() {
  [[ $1 =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]]
}

image_retention_available_bytes() {
  df --output=avail -B1 "$RENTAL_OPS_STATE_DIR" | tail -n 1 | tr -d ' '
}

image_retention_emit() {
  local identifier=$1 event=$2 payload=$3
  jq --compact-output \
    --arg event "$event" \
    '. + {event: $event}' <<<"$payload" |
    systemd-cat --identifier="$identifier" --priority=info
}

image_retention_plan() {
  local current repository expected_current_id running_image_id
  local retained_json protected_releases_json protected_json
  local container_json container_list image_list
  local protected_id revision metadata_tag metadata_id
  local -a retained_refs=() retained_revisions=() protected_ids=()
  local -a image_ids=() container_ids=()

  ops_require_absolute_path \
    "RENTAL_DEPLOYMENT_RETENTION_FILE" "$RENTAL_DEPLOYMENT_RETENTION_FILE"
  [[ -f $RENTAL_DEPLOYMENT_RETENTION_FILE &&
    ! -L $RENTAL_DEPLOYMENT_RETENTION_FILE ]] || {
    printf 'Deployment retention index is unavailable or unsafe\n' >&2
    return 65
  }
  [[ $RENTAL_IMAGE_RETENTION_COUNT =~ ^[1-9][0-9]*$ ]]

  current=$(ops_read_image_reference) || return
  image_retention_validate_digest "$current" || return 65
  jq -e \
    --arg current "$current" \
    --argjson maximum "$RENTAL_IMAGE_RETENTION_COUNT" '
      (.schemaVersion == 1 or .schemaVersion == 2) and
      .minimumRetainedReleases == $maximum and
      (.retainedReleases | type) == "array" and
      (.retainedReleases | length) >= 1 and
      (.retainedReleases | length) <= $maximum and
      .retainedReleases[0].candidateImage == $current and
      all(.retainedReleases[];
        (.candidateImage | test("^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$")) and
        (.sourceRevision | test("^[0-9a-f]{40}$"))) and
      (([.retainedReleases[].candidateImage] | unique | length) ==
        (.retainedReleases | length)) and
      (([.retainedReleases[].sourceRevision] | unique | length) ==
        (.retainedReleases | length)) and
      ((.protectedReleases // []) | type) == "array" and
      ((.protectedReleases // []) | length) <= 1 and
      all((.protectedReleases // [])[];
        (.candidateImage | test("^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$")) and
        (.sourceRevision | test("^[0-9a-f]{40}$")) and
        (.protectedSnapshot | test("/protected/pre-sqlite-[^/]+$")))
    ' "$RENTAL_DEPLOYMENT_RETENTION_FILE" >/dev/null || {
    printf 'Deployment retention index is invalid or does not protect current\n' >&2
    return 65
  }

  while IFS= read -r current; do
    [[ -n $current ]] && retained_refs+=("$current")
  done < <(
    jq -r '(.retainedReleases + (.protectedReleases // []))[].candidateImage' \
      "$RENTAL_DEPLOYMENT_RETENTION_FILE"
  )
  while IFS= read -r revision; do
    [[ -n $revision ]] && retained_revisions+=("$revision")
  done < <(
    jq -r '(.retainedReleases + (.protectedReleases // []))[].sourceRevision' \
      "$RENTAL_DEPLOYMENT_RETENTION_FILE"
  )
  repository=${retained_refs[0]%%@sha256:*}
  for current in "${retained_refs[@]}"; do
    [[ $current == "$repository"@sha256:* ]] || {
      printf 'Retained images do not belong to one repository\n' >&2
      return 65
    }
    protected_id=$(docker image inspect --format '{{.Id}}' "$current") || return
    protected_ids+=("$protected_id")
  done
  expected_current_id=${protected_ids[0]}
  running_image_id=$(
    docker inspect --format '{{.Image}}' "$RENTAL_CONTAINER_NAME"
  ) || return
  [[ $running_image_id == "$expected_current_id" ]] || {
    printf 'Running container does not match the retained current image\n' >&2
    return 65
  }

  for revision in "${retained_revisions[@]}"; do
    metadata_tag="$repository:metadata-$revision"
    if metadata_id=$(
      docker image inspect --format '{{.Id}}' "$metadata_tag" 2>/dev/null
    ); then
      protected_ids+=("$metadata_id")
    fi
  done

  container_list=$(docker container ls --all --no-trunc --quiet) || return
  if [[ -n $container_list ]]; then
    while IFS= read -r protected_id; do
      [[ -n $protected_id ]] && container_ids+=("$protected_id")
    done < <(sort -u <<<"$container_list")
    container_json=$(docker container inspect "${container_ids[@]}") || return
    while IFS= read -r protected_id; do
      [[ -n $protected_id ]] && image_ids+=("$protected_id")
    done < <(jq -r '.[].Image' <<<"$container_json" | sort -u)
    protected_ids+=("${image_ids[@]}")
  fi

  protected_json=$(printf '%s\n' "${protected_ids[@]}" | jq -Rsc '
    split("\n") | map(select(length > 0)) | unique | sort
  ') || return
  retained_json=$(jq -c '[.retainedReleases[] | {
    candidateImage, sourceRevision, completedAt
  }]' "$RENTAL_DEPLOYMENT_RETENTION_FILE") || return
  protected_releases_json=$(jq -c '[.protectedReleases // [] | .[] | {
    candidateImage, sourceRevision, protectedSnapshot, protectedAt
  }]' "$RENTAL_DEPLOYMENT_RETENTION_FILE") || return
  image_list=$(docker image ls --all --no-trunc --quiet) || return
  image_ids=()
  if [[ -n $image_list ]]; then
    while IFS= read -r protected_id; do
      [[ -n $protected_id ]] && image_ids+=("$protected_id")
    done < <(sort -u <<<"$image_list")
    docker image inspect "${image_ids[@]}"
  else
    printf '[]\n'
  fi | jq -c \
    --arg repository "$repository" \
    --arg title "$RENTAL_IMAGE_TITLE" \
    --arg currentImage "$expected_current_id" \
    --argjson retained "$retained_json" \
    --argjson protectedReleases "$protected_releases_json" \
    --argjson protected "$protected_json" '
      . as $inventory
      |
      def metadata_tag:
        . as $tag
        | ($repository + ":metadata-") as $prefix
        | ($tag | startswith($prefix)) and
          (($tag | ltrimstr($prefix)) | test("^[0-9a-f]{40}$"));
      [
        $inventory[]
        | select(
            .Config.Labels["org.opencontainers.image.title"] == $title
            or any(.RepoTags[]?; metadata_tag)
          )
        | {
            id: .Id,
            sizeBytes: (.Size // 0),
            tags: ((.RepoTags // []) | sort),
            digests: ((.RepoDigests // []) | sort),
            revision:
              (.Config.Labels["org.opencontainers.image.revision"] // null),
            kind:
              (if .Config.Labels["org.opencontainers.image.title"] == $title
               then "application"
               else "release-metadata"
               end)
          }
      ] | unique_by(.id) | sort_by(.id) as $managed
      | [$managed[] | select(.id as $id | ($protected | index($id)) == null)]
        as $removals
      | {
          schemaVersion: 1,
          repository: $repository,
          currentImageId: $currentImage,
          retainedReleases: $retained,
          protectedReleases: $protectedReleases,
          protectedImageIds: $protected,
          managedImageCount: ($managed | length),
          removalCount: ($removals | length),
          candidateVirtualBytes: ([$removals[].sizeBytes] | add // 0),
          removals: $removals
        }
    '
}

image_retention_cleanup() {
  local mode=${1:-apply}
  local identifier=${2:-rental-image-cleanup}
  local plan before after reclaimed verification result removal_id
  local -a removal_ids=()
  [[ $mode == apply || $mode == dry-run ]] || return 64

  plan=$(image_retention_plan) || return
  image_retention_emit "$identifier" image.cleanup.planned "$plan" || return
  if [[ $mode == dry-run ]]; then
    jq '. + {mode: "dry-run"}' <<<"$plan"
    return
  fi

  before=$(image_retention_available_bytes) || return
  while IFS= read -r removal_id; do
    [[ -n $removal_id ]] && removal_ids+=("$removal_id")
  done < <(jq -r '.removals[].id' <<<"$plan")
  if ((${#removal_ids[@]})); then
    docker image rm -- "${removal_ids[@]}" >/dev/null || return
  fi

  verification=$(image_retention_plan) || return
  [[ $(jq -r '.removalCount' <<<"$verification") == 0 ]] || {
    printf 'Managed image cleanup left unprotected candidates behind\n' >&2
    return 70
  }
  ops_wait_ready || return
  after=$(image_retention_available_bytes) || return
  reclaimed=$((after > before ? after - before : 0))
  result=$(jq -cn \
    --argjson removed "${#removal_ids[@]}" \
    --argjson candidateVirtualBytes "$(jq -r '.candidateVirtualBytes' <<<"$plan")" \
    --argjson reclaimedBytes "$reclaimed" \
    --argjson availableBytes "$after" '{
      result: "success",
      removedImageCount: $removed,
      candidateVirtualBytes: $candidateVirtualBytes,
      reclaimedBytes: $reclaimedBytes,
      availableBytes: $availableBytes
    }') || return
  image_retention_emit "$identifier" image.cleanup.completed "$result" || return
  printf '%s\n' "$result"
}
