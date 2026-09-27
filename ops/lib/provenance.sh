#!/usr/bin/env bash

# This marker is checked against the archived operations bundle before a
# release advertises that its host deployer understands cargo-source-v1.
RENTAL_PROVENANCE_CONTRACT_V3=cargo-source-v1

provenance_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

provenance_image_label() {
  docker image inspect --format "{{index .Config.Labels \"$2\"}}" "$1"
}

provenance_copy_image_file() {
  local container=$1 path=$2 destination=$3
  docker cp "$container:$path" "$destination" >/dev/null || return 65
  [[ -f $destination && ! -L $destination ]] || return 65
}

provenance_manifest_paths() {
  jq -r '.files[].path' "$1"
}

provenance_verify_manifest_shape() {
  local manifest=$1 kind=$2
  jq --sort-keys --compact-output . "$manifest" | cmp -s - "$manifest" || return 65
  jq -e --arg kind "$kind" '
    .schemaVersion == 1 and .kind == $kind and
    (.files | type == "array" and length > 0) and
    all(.files[];
      (.path | type == "string" and
        test("^[A-Za-z0-9][A-Za-z0-9_./-]*$") and
        (contains("..") | not) and
        (startswith("/") | not) and
        (endswith("/") | not)) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))) and
    all(.files[]; keys == ["path", "sha256"]) and
    ([.files[].path] == ([.files[].path] | unique | sort)) and
    (keys == ["files", "kind", "schemaVersion"])
  ' "$manifest" >/dev/null
}

provenance_verify_source_manifest() {
  local manifest=$1 source_tar=$2 path expected actual type listing
  provenance_verify_manifest_shape "$manifest" source-inputs || return 65
  jq -e '
    ([.files[].path] | index("Dockerfile.native") != null) and
    ([.files[].path] | index("experiments/rust-replay/Cargo.toml") != null) and
    ([.files[].path] | index("experiments/rust-replay/Cargo.lock") != null) and
    ([.files[].path] | index("scripts/install-curl-impersonate") != null) and
    ([.files[].path] | index("scripts/curl-impersonate-version") != null) and
    ([.files[].path] | index("experiments/production-image/assemble") != null) and
    ([.files[].path] | index("experiments/production-image/licenses") != null) and
    ([.files[].path] | index("compose.production.yaml") != null) and
    ([.files[].path] | index("ops/compose.native.yaml") != null) and
    ([.files[].path] | any(startswith("experiments/rust-replay/src/") and endswith(".rs"))) and
    all(.files[].path;
      . == "Dockerfile.native" or . == "compose.production.yaml" or
      . == "ops/compose.native.yaml" or
      . == "experiments/rust-replay/Cargo.toml" or
      . == "experiments/rust-replay/Cargo.lock" or
      . == "scripts/install-curl-impersonate" or
      . == "scripts/curl-impersonate-version" or
      . == "experiments/production-image/assemble" or
      . == "experiments/production-image/licenses" or
      startswith("experiments/rust-replay/src/"))
  ' "$manifest" >/dev/null || return 65
  [[ -f $source_tar && ! -L $source_tar ]] || return 65
  (( $(stat -c '%s' "$source_tar") <= 8388608 )) || return 65
  # Read members without extracting paths onto the host. GNU tar's verbose
  # leading type character rejects links, devices, and directory entries.
  listing=$(tar --list --verbose --file "$source_tar") || return 65
  while IFS= read -r type; do
    [[ $type == - ]] || return 65
  done < <(printf '%s\n' "$listing" | cut -c1)
  local members
  members=$(tar --list --file "$source_tar") || return 65
  [[ $members == "$(provenance_manifest_paths "$manifest")" ]] || return 65
  while IFS= read -r path; do
    expected=$(jq -r --arg path "$path" '.files[] | select(.path == $path) | .sha256' "$manifest") || return 65
    actual=$(tar --extract --to-stdout --file "$source_tar" -- "$path" | sha256sum | awk '{print $1}') || return 65
    [[ $actual == "$expected" ]] || return 65
  done < <(provenance_manifest_paths "$manifest")
}

provenance_verify_transport_manifest() {
  local manifest=$1 libraries=$2 container=$3 scratch=$4 path expected actual
  provenance_verify_manifest_shape "$manifest" transport-files || return 65
  jq -e '
    ([.files[].path] | index("usr/local/bin/curl-impersonate") != null) and
    ([.files[].path] | index("etc/ssl/certs/ca-certificates.crt") != null) and
    ([.files[].path] | index("etc/nsswitch.conf") != null) and
    all(.files[].path;
      . == "usr/local/bin/curl-impersonate" or
      . == "etc/ssl/certs/ca-certificates.crt" or
      . == "etc/nsswitch.conf" or
      startswith("lib/") or startswith("usr/lib/") or
      test("^lib64/ld-linux-[A-Za-z0-9_-]+\\.so\\.[0-9]+$")) and
    ([.files[].path] | any(test("^lib64/ld-linux-[A-Za-z0-9_-]+\\.so\\.[0-9]+$")))
  ' "$manifest" >/dev/null || return 65
  [[ -s $libraries && ! -L $libraries ]] || return 65
  local expected_paths
  expected_paths=$(printf '%s\n' \
    usr/local/bin/curl-impersonate \
    etc/ssl/certs/ca-certificates.crt \
    etc/nsswitch.conf; sed 's@^/@@' "$libraries") || return 65
  expected_paths=$(printf '%s\n' "$expected_paths" | LC_ALL=C sort -u)
  [[ $expected_paths == "$(provenance_manifest_paths "$manifest")" ]] || return 65
  while IFS= read -r path; do
    expected=$(jq -r --arg path "$path" '.files[] | select(.path == $path) | .sha256' "$manifest") || return 65
    provenance_copy_image_file "$container" "/$path" "$scratch/transport-file" || return 65
    actual=$(provenance_sha256 "$scratch/transport-file") || return 65
    [[ $actual == "$expected" ]] || return 65
    rm -f -- "$scratch/transport-file"
  done < <(provenance_manifest_paths "$manifest")
}

provenance_verify_v3_image() (
  set -Eeuo pipefail
  local bundle=$1 image=$2 metadata=$3 scratch container="" name expected actual docker_from
  scratch=$(mktemp -d) || return 65
  trap '[[ -z $container ]] || docker rm "$container" >/dev/null 2>&1; rm -rf -- "$scratch"' EXIT
  for name in \
    cargoLockSha256:com.rental-apartments.cargo-lock.sha256 \
    sourceInputsSha256:com.rental-apartments.source-inputs.sha256 \
    binarySha256:com.rental-apartments.binary.sha256 \
    curlSha256:com.rental-apartments.curl.sha256 \
    transportClosureSha256:com.rental-apartments.transport-closure.sha256; do
    expected=$(jq -r ".${name%%:*}" "$metadata")
    actual=$(provenance_image_label "$image" "${name#*:}")
    [[ $actual == "$expected" ]] || return 65
  done
  [[ $(provenance_image_label "$image" org.opencontainers.image.revision) == "$(jq -r .sourceRevision "$metadata")" ]] || return 65
  [[ $(provenance_image_label "$image" com.rental-apartments.runtime) == rust ]] || return 65
  [[ $(provenance_image_label "$image" com.rental-apartments.source.dirty) == false ]] || return 65
  [[ $(provenance_image_label "$image" com.rental-apartments.rust-version) == "$(jq -r .rustVersion "$metadata")" ]] || return 65
  [[ $(provenance_image_label "$image" com.rental-apartments.curl-version) == "$(jq -r .curlImpersonateVersion "$metadata")" ]] || return 65
  [[ $(provenance_image_label "$image" com.rental-apartments.state.backend) == sqlite ]] || return 65
  [[ $(provenance_image_label "$image" com.rental-apartments.state.schema.minimum) == "$(jq -r .minimumStateSchema "$metadata")" ]] || return 65
  [[ $(provenance_image_label "$image" com.rental-apartments.state.schema.maximum) == "$(jq -r .maximumStateSchema "$metadata")" ]] || return 65
  docker image inspect --format '{{json .Config.Labels}}' "$image" |
    jq -e 'has("org.opencontainers.image.package-lock.sha256") | not' >/dev/null || return 65
  container=$(docker create "$image" /usr/local/bin/rental-app) || return 65
  provenance_copy_image_file "$container" /usr/local/bin/rental-app "$scratch/rental-app" || return 65
  [[ $(provenance_sha256 "$scratch/rental-app") == "$(jq -r .binarySha256 "$metadata")" ]] || return 65
  provenance_copy_image_file "$container" /usr/local/share/licenses/rental-app/Cargo.lock "$scratch/Cargo.lock" || return 65
  [[ $(provenance_sha256 "$scratch/Cargo.lock") == "$(jq -r .cargoLockSha256 "$metadata")" ]] || return 65
  provenance_copy_image_file "$container" /usr/local/share/native-image/source-inputs.tar "$scratch/source-inputs.tar" || return 65
  provenance_verify_source_manifest "$bundle/source-inputs.json" "$scratch/source-inputs.tar" || return 65
  actual=$(tar --extract --to-stdout --file "$scratch/source-inputs.tar" \
    scripts/curl-impersonate-version | grep '^CURL_IMPERSONATE_VERSION=') || return 65
  [[ $actual == "CURL_IMPERSONATE_VERSION=$(jq -r .curlImpersonateVersion "$metadata")" ]] || return 65
  docker_from=$(tar --extract --to-stdout --file "$scratch/source-inputs.tar" \
    Dockerfile.native | sed -n '/^FROM rust:/p') || return 65
  [[ $docker_from =~ ^FROM[[:space:]]rust:([0-9]+\.[0-9]+\.[0-9]+)-bookworm@sha256:[a-f0-9]{64}[[:space:]]AS[[:space:]]build$ ]] || return 65
  [[ ${BASH_REMATCH[1]} == "$(jq -r .rustVersion "$metadata")" ]] || return 65
  provenance_copy_image_file "$container" /usr/local/share/native-image/components.json "$scratch/components.json" || return 65
  jq -e --slurpfile release "$metadata" '
    .runtime == "rust" and .sourceDirty == false and
    .toolchain == $release[0].rustVersion and
    .sourceRevision == $release[0].sourceRevision and
    .cargoLockSha256 == $release[0].cargoLockSha256 and
    .sourceInputsSha256 == $release[0].sourceInputsSha256 and
    .binarySha256 == $release[0].binarySha256 and
    .curlSha256 == $release[0].curlSha256 and
    .transportClosureSha256 == $release[0].transportClosureSha256 and
    .curlImpersonateVersion == $release[0].curlImpersonateVersion and
    (keys == ["binarySha256", "cargoLockSha256", "curlImpersonateVersion",
      "curlSha256", "runtime", "sourceDirty", "sourceInputsSha256",
      "sourceRevision", "toolchain", "transportClosureSha256"])
  ' "$scratch/components.json" >/dev/null || return 65
  provenance_copy_image_file "$container" /usr/local/share/native-image/libraries.txt "$scratch/libraries.txt" || return 65
  provenance_verify_transport_manifest "$bundle/transport-files.json" "$scratch/libraries.txt" "$container" "$scratch" || return 65
  provenance_copy_image_file "$container" /usr/local/bin/curl-impersonate "$scratch/curl" || return 65
  [[ $(provenance_sha256 "$scratch/curl") == "$(jq -r .curlSha256 "$metadata")" ]] || return 65
)

provenance_verify_v3_release() {
  local bundle=$1 image=$2 metadata=$3 artifact expected actual image_runtime
  jq -e --arg image "$image" --arg revision "$DEPLOYMENT_SOURCE_REVISION" \
    --arg provenance_kind "$RENTAL_PROVENANCE_CONTRACT_V3" '
    .schemaVersion == 3 and
    .provenanceKind == $provenance_kind and
    .runtime == "rust" and
    .deployableStateBackends == ["sqlite"] and
    .deployableRuntimes == ["node", "rust"] and
    .cutoverRollbackContract == "preserve-live-state-v1" and
    .sourceDirty == false and
    (.rustVersion | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.curlImpersonateVersion | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    .deployableProvenanceContracts == ["legacy-package-lock-v2", "cargo-source-v3"] and
    (has("packageLockSha256") | not) and
    .imageReference == $image and .imageDigest == ($image | split("@")[1]) and
    .sourceRevision == $revision and
    .stateBackend == "sqlite" and
    (.minimumStateSchema | type == "number") and
    (.maximumStateSchema | type == "number") and
    .minimumStateSchema >= 1 and
    .maximumStateSchema >= .minimumStateSchema and
    .minimumStateSchema == (.minimumStateSchema | floor) and
    .maximumStateSchema == (.maximumStateSchema | floor) and
    (keys == ["binarySha256", "cargoLockSha256", "composeSha256",
      "curlImpersonateVersion", "curlSha256", "cutoverRollbackContract",
      "deployableProvenanceContracts", "deployableRuntimes",
      "deployableStateBackends", "imageDigest", "imageReference",
      "maximumStateSchema", "minimumStateSchema", "operationsBundleSha256",
      "provenanceKind", "runtime", "rustVersion", "schemaVersion",
      "sourceDirty", "sourceInputsSha256", "sourceRevision", "stateBackend",
      "transportClosureSha256"]) and
    all([.cargoLockSha256, .sourceInputsSha256, .binarySha256,
         .curlSha256, .transportClosureSha256, .composeSha256,
         .operationsBundleSha256][];
      type == "string" and test("^[0-9a-f]{64}$"))
  ' "$metadata" >/dev/null || return 65
  image_runtime=$(ops_runtime "$image") || return 65
  [[ $image_runtime == rust ]] || return 65
  for artifact in \
    compose.production.yaml:composeSha256 \
    operations.tar:operationsBundleSha256 \
    source-inputs.json:sourceInputsSha256 \
    transport-files.json:transportClosureSha256; do
    [[ -f $bundle/${artifact%%:*} && ! -L $bundle/${artifact%%:*} ]] || return 65
    expected=$(jq -r ".${artifact#*:}" "$metadata") || return 65
    actual=$(provenance_sha256 "$bundle/${artifact%%:*}") || return 65
    [[ $actual == "$expected" ]] || return 65
  done
  provenance_verify_manifest_shape "$bundle/source-inputs.json" source-inputs || return 65
  provenance_verify_manifest_shape "$bundle/transport-files.json" transport-files || return 65
  expected=$(jq -r --arg path experiments/rust-replay/Cargo.lock \
    '.files[] | select(.path == $path) | .sha256' "$bundle/source-inputs.json") || return 65
  [[ $expected == "$(jq -r .cargoLockSha256 "$metadata")" ]] || return 65
  expected=$(jq -r --arg path compose.production.yaml \
    '.files[] | select(.path == $path) | .sha256' "$bundle/source-inputs.json") || return 65
  [[ $expected == "$(jq -r .composeSha256 "$metadata")" ]] || return 65
  expected=$(jq -r --arg path ops/compose.native.yaml \
    '.files[] | select(.path == $path) | .sha256' "$bundle/source-inputs.json") || return 65
  deployment_validate_operations_archive "$bundle/operations.tar" || return 65
  actual=$(tar --extract --to-stdout --file "$bundle/operations.tar" \
    ops/compose.native.yaml | sha256sum | awk '{print $1}') || return 65
  [[ $expected == "$actual" ]] || return 65
  provenance_verify_v3_image "$bundle" "$image" "$metadata" || return 65
}
