#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: infra/hcloud/bootstrap.sh [--check | --dry-run]
       [--ssh-public-key-file FILE] [--initial-secret-file FILE]

Required environment:
  HCLOUD_SERVER_TYPE          Explicit Hetzner server type
  HCLOUD_LOCATION             Explicit Hetzner location
  HCLOUD_IMAGE_ID             Reviewed immutable numeric Ubuntu LTS image ID
  HCLOUD_VOLUME_SIZE_GB       Backup volume size

Optional names default to rental-apartments-production[-ssh|-firewall|-backups].
The initial secret is used only when creating the server and is never replaced.
EOF
}

MODE=apply
INITIAL_SECRET_FILE=${HCLOUD_INITIAL_SECRET_FILE:-}
SSH_PUBLIC_KEY_FILE=${HCLOUD_SSH_PUBLIC_KEY_FILE:-}
while (($#)); do
  case $1 in
    --check) MODE=check; shift ;;
    --dry-run) MODE=dry-run; shift ;;
    --ssh-public-key-file)
      (($# >= 2)) || { usage >&2; exit 64; }
      SSH_PUBLIC_KEY_FILE=$2
      shift 2
      ;;
    --initial-secret-file)
      (($# >= 2)) || { usage >&2; exit 64; }
      INITIAL_SECRET_FILE=$2
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
done

SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPOSITORY_ROOT=$(cd -- "$SCRIPT_DIRECTORY/../.." && pwd)
SERVER_NAME=${HCLOUD_SERVER_NAME:-rental-apartments-production}
SSH_KEY_NAME=${HCLOUD_SSH_KEY_NAME:-rental-apartments-production-ssh}
FIREWALL_NAME=${HCLOUD_FIREWALL_NAME:-rental-apartments-production-firewall}
VOLUME_NAME=${HCLOUD_VOLUME_NAME:-rental-apartments-production-backups}
SERVER_TYPE=${HCLOUD_SERVER_TYPE:-}
LOCATION=${HCLOUD_LOCATION:-}
IMAGE_ID=${HCLOUD_IMAGE_ID:-}
VOLUME_SIZE=${HCLOUD_VOLUME_SIZE_GB:-}
SSH_USER=${HCLOUD_SSH_USER:-rental-deploy}
LABEL_REPOSITORY=rental-apartments
LABEL_ROLE=application
LABEL_ENVIRONMENT=production

for command_name in hcloud jq ssh tar base64; do
  command -v "$command_name" >/dev/null || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 69
  }
done
for pair in \
  "HCLOUD_SERVER_TYPE:$SERVER_TYPE" \
  "HCLOUD_LOCATION:$LOCATION" \
  "HCLOUD_IMAGE_ID:$IMAGE_ID" \
  "HCLOUD_VOLUME_SIZE_GB:$VOLUME_SIZE" \
  "SSH public key file:$SSH_PUBLIC_KEY_FILE"; do
  [[ -n ${pair#*:} ]] || {
    printf 'Required input is missing: %s\n' "${pair%%:*}" >&2
    exit 64
  }
done
[[ $IMAGE_ID =~ ^[1-9][0-9]*$ ]] || {
  printf 'HCLOUD_IMAGE_ID must be an immutable numeric image identifier\n' >&2
  exit 64
}
[[ $VOLUME_SIZE =~ ^[1-9][0-9]*$ ]]
[[ -f $SSH_PUBLIC_KEY_FILE && ! -L $SSH_PUBLIC_KEY_FILE ]]
ssh_public_key=$(<"$SSH_PUBLIC_KEY_FILE")
[[ $ssh_public_key == ssh-*' '* && $ssh_public_key != *$'\n'* ]]

if [[ -n $INITIAL_SECRET_FILE ]]; then
  [[ -f $INITIAL_SECRET_FILE && ! -L $INITIAL_SECRET_FILE ]] || {
    printf 'Initial secret input must be a regular, non-symlink file\n' >&2
    exit 65
  }
  for key in TELEGRAM_BOT_TOKEN TELEGRAM_OWNER_ID GHCR_IMAGE_REPOSITORY GHCR_USERNAME GHCR_READ_TOKEN; do
    [[ $(grep --count --extended-regexp "^${key}=.+" "$INITIAL_SECRET_FILE") == 1 ]] || {
      printf 'Initial secret is incomplete: %s\n' "$key" >&2
      exit 65
    }
  done
fi

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/rental-hcloud.XXXXXX")
cleanup() { rm -rf -- "$temporary_directory"; }
trap cleanup EXIT

yaml_quote() { sed "s/'/''/g" <<<"$1"; }
append_file() {
  local path=$1 mode=$2 source=$3
  {
    printf '  - path: %s\n    owner: root:root\n    permissions: \"%s\"\n    content: |\n' \
      "$path" "$mode"
    sed 's/^/      /' "$source"
  } >>"$temporary_directory/write-files.yaml"
}
render_cloud_init() {
  : >"$temporary_directory/write-files.yaml"
  # Keep provider user data small. The full operations bundle is transferred
  # over SSH after cloud-init establishes this trusted helper and account.
  append_file /usr/local/sbin/rental-host-bootstrap 0755 \
    "$SCRIPT_DIRECTORY/host-bootstrap.sh"
  if [[ -n $INITIAL_SECRET_FILE ]]; then
    {
      printf '  - path: /etc/rental-apartments/env\n'
      printf '    owner: root:root\n    permissions: \"0600\"\n'
      printf '    encoding: b64\n    content: %s\n' \
        "$(base64 <"$INITIAL_SECRET_FILE" | tr -d '\n')"
    } >>"$temporary_directory/write-files.yaml"
  fi
  awk -v key="$(yaml_quote "$ssh_public_key")" \
    -v writes="$temporary_directory/write-files.yaml" '
      /__RENTAL_WRITE_FILES__/ {
        while ((getline line < writes) > 0) print line
        close(writes)
        next
      }
      {gsub(/__RENTAL_SSH_PUBLIC_KEY__/, sprintf("\047%s\047", key))}
      {print}
    ' "$SCRIPT_DIRECTORY/cloud-init.yaml" >"$temporary_directory/cloud-init.yaml"
}

render_cloud_init
user_data_bytes=$(wc -c <"$temporary_directory/cloud-init.yaml")
user_data_max_bytes=32768
((user_data_bytes <= user_data_max_bytes)) || {
  printf 'Rendered cloud-init exceeds Hetzner user-data limit: %s > %s bytes\n' \
    "$user_data_bytes" "$user_data_max_bytes" >&2
  exit 65
}

drift=0
note_drift() {
  printf 'DRIFT %s\n' "$1" >&2
  drift=1
}
mutate() {
  local description=$1
  shift
  if [[ $MODE == apply ]]; then
    "$@"
  else
    printf 'PLAN %s\n' "$description"
    if [[ $MODE == check ]]; then
      drift=1
    fi
  fi
}

resource_json() {
  local kind=$1 name=$2 listing matches count
  listing=$(hcloud "$kind" list --output json)
  matches=$(jq --compact-output \
    --arg name "$name" \
    --arg repository "$LABEL_REPOSITORY" \
    --arg role "$LABEL_ROLE" \
    --arg environment "$LABEL_ENVIRONMENT" '
      [.[] | select(
        .name == $name or
        (.labels.repository == $repository and
         .labels.role == $role and
         .labels.environment == $environment)
      )]' <<<"$listing")
  count=$(jq 'length' <<<"$matches")
  if ((count > 1)); then
    printf 'Refusing ambiguous %s reconciliation for exact name %s\n' "$kind" "$name" >&2
    return 65
  fi
  if ((count == 1)); then
    [[ $(jq -r '.[0].name' <<<"$matches") == "$name" ]] || {
      printf 'Label-selected %s has unexpected name; refusing rename\n' "$kind" >&2
      return 65
    }
    jq --compact-output '.[0]' <<<"$matches"
  fi
}

ensure_labels() {
  local kind=$1 name=$2 object=$3
  if ! jq -e \
    --arg repository "$LABEL_REPOSITORY" --arg role "$LABEL_ROLE" \
    --arg environment "$LABEL_ENVIRONMENT" \
    '.labels.repository == $repository and .labels.role == $role and
     .labels.environment == $environment' <<<"$object" >/dev/null; then
    mutate "$kind $name labels" hcloud "$kind" update "$name" \
      --label "repository=$LABEL_REPOSITORY" \
      --label "role=$LABEL_ROLE" \
      --label "environment=$LABEL_ENVIRONMENT"
  fi
}

ssh_object=$(resource_json ssh-key "$SSH_KEY_NAME" || exit $?)
if [[ -z $ssh_object ]]; then
  mutate "create SSH key $SSH_KEY_NAME" hcloud ssh-key create \
    --name "$SSH_KEY_NAME" --public-key-from-file "$SSH_PUBLIC_KEY_FILE" \
    --label "repository=$LABEL_REPOSITORY" --label "role=$LABEL_ROLE" \
    --label "environment=$LABEL_ENVIRONMENT"
  if [[ $MODE == apply ]]; then
    ssh_object=$(resource_json ssh-key "$SSH_KEY_NAME")
  fi
else
  [[ $(jq -r '.public_key' <<<"$ssh_object") == "$ssh_public_key" ]] || {
    printf 'Existing SSH key differs; replacement is intentionally unsupported\n' >&2
    exit 65
  }
  ensure_labels ssh-key "$SSH_KEY_NAME" "$ssh_object"
fi

rules_file=$temporary_directory/firewall-rules.json
printf '%s\n' \
  '[{"direction":"in","protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"],"description":"Key-only SSH"}]' \
  >"$rules_file"
firewall_object=$(resource_json firewall "$FIREWALL_NAME" || exit $?)
if [[ -z $firewall_object ]]; then
  mutate "create SSH-only firewall $FIREWALL_NAME" hcloud firewall create \
    --name "$FIREWALL_NAME" --rules-file "$rules_file" \
    --label "repository=$LABEL_REPOSITORY" --label "role=$LABEL_ROLE" \
    --label "environment=$LABEL_ENVIRONMENT"
  if [[ $MODE == apply ]]; then
    firewall_object=$(resource_json firewall "$FIREWALL_NAME")
  fi
else
  ensure_labels firewall "$FIREWALL_NAME" "$firewall_object"
  if ! jq -e --slurpfile wanted "$rules_file" '
    [.rules[] | {direction,protocol,port,source_ips,description}] == $wanted[0]
  ' <<<"$firewall_object" >/dev/null; then
    mutate "replace firewall rules with key-only SSH" \
      hcloud firewall replace-rules "$FIREWALL_NAME" --rules-file "$rules_file"
  fi
fi

volume_object=$(resource_json volume "$VOLUME_NAME" || exit $?)
if [[ -z $volume_object ]]; then
  mutate "create protected backup volume $VOLUME_NAME" hcloud volume create \
    --name "$VOLUME_NAME" --size "$VOLUME_SIZE" --location "$LOCATION" \
    --format ext4 \
    --label "repository=$LABEL_REPOSITORY" --label "role=$LABEL_ROLE" \
    --label "environment=$LABEL_ENVIRONMENT"
  if [[ $MODE == apply ]]; then
    volume_object=$(resource_json volume "$VOLUME_NAME")
  fi
else
  ensure_labels volume "$VOLUME_NAME" "$volume_object"
  [[ $(jq -r '.size' <<<"$volume_object") == "$VOLUME_SIZE" &&
    $(jq -r '.location.name' <<<"$volume_object") == "$LOCATION" ]] || {
    printf 'Existing volume size/location drift requires manual review\n' >&2
    exit 65
  }
fi
volume_id=
if [[ -n $volume_object ]]; then
  volume_id=$(jq -r '.id // empty' <<<"$volume_object")
fi

server_object=$(resource_json server "$SERVER_NAME" || exit $?)
if [[ -z $server_object ]]; then
  if [[ $MODE == apply ]]; then
    hcloud server create --name "$SERVER_NAME" --type "$SERVER_TYPE" \
      --location "$LOCATION" --image "$IMAGE_ID" --ssh-key "$SSH_KEY_NAME" \
      --firewall "$FIREWALL_NAME" --volume "$VOLUME_NAME" \
      --user-data-from-file "$temporary_directory/cloud-init.yaml" \
      --label "repository=$LABEL_REPOSITORY" --label "role=$LABEL_ROLE" \
      --label "environment=$LABEL_ENVIRONMENT"
    server_object=$(resource_json server "$SERVER_NAME")
  else
    mutate "create server $SERVER_NAME from immutable image $IMAGE_ID" true
  fi
else
  ensure_labels server "$SERVER_NAME" "$server_object"
  jq -e --arg type "$SERVER_TYPE" --arg location "$LOCATION" \
    --argjson image "$IMAGE_ID" '
      .server_type.name == $type and
      (.location.name // .datacenter.location.name) == $location and
      .image.id == $image' <<<"$server_object" >/dev/null || {
    printf 'Existing server type/location/image drift requires manual review\n' >&2
    exit 65
  }
fi
server_id=
if [[ -n $server_object ]]; then
  server_id=$(jq -r '.id // empty' <<<"$server_object")
fi

if [[ -n $server_id && -n $volume_id ]]; then
  volume_object=$(hcloud volume describe "$VOLUME_NAME" --output json)
  jq -e --argjson server "$server_id" \
    '(.server == $server) or (.server.id == $server)' \
    <<<"$volume_object" >/dev/null ||
    mutate "attach backup volume to server" \
      hcloud volume attach "$VOLUME_NAME" --server "$SERVER_NAME"
fi
if [[ -n $server_id ]]; then
  firewall_object=$(resource_json firewall "$FIREWALL_NAME")
  jq -e --argjson server "$server_id" \
    'any(.applied_to[]?; .server.id == $server)' <<<"$firewall_object" >/dev/null ||
    mutate "attach firewall to server" \
      hcloud firewall apply-to-resource "$FIREWALL_NAME" \
      --type server --server "$SERVER_NAME"
  server_object=$(hcloud server describe "$SERVER_NAME" --output json)
  jq -e '
    .protection.delete == true and .protection.rebuild == true
  ' <<<"$server_object" >/dev/null ||
    mutate "enable server delete and rebuild protection" \
      hcloud server enable-protection "$SERVER_NAME" delete rebuild
  volume_object=$(hcloud volume describe "$VOLUME_NAME" --output json)
  jq -e '.protection.delete == true' <<<"$volume_object" >/dev/null ||
    mutate "enable volume delete protection" \
      hcloud volume enable-protection "$VOLUME_NAME" delete
fi

if [[ $MODE == dry-run ]]; then
  printf 'Dry run complete; no resources or host files changed\n'
  exit 0
fi

if [[ -n $server_id ]]; then
  address=$(jq -r '.public_net.ipv4.ip' <<<"$server_object")
  ssh_target=${HCLOUD_SSH_TARGET:-"$SSH_USER@$address"}
  ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
  if [[ $MODE == apply ]]; then
    for _attempt in {1..60}; do
      ssh "${ssh_options[@]}" "$ssh_target" cloud-init status --wait >/dev/null 2>&1 &&
        break
      sleep 2
    done
  fi
  bundle_mode=(--bundle)
  [[ $MODE == check ]] && bundle_mode+=(--check)
  COPYFILE_DISABLE=1 LC_ALL=C tar --no-xattrs --create --gzip \
    --directory "$REPOSITORY_ROOT" --file - \
    infra/hcloud/host-bootstrap.sh infra/hcloud/journald.conf infra/systemd ops |
    ssh "${ssh_options[@]}" "$ssh_target" \
      sudo env \
      "RENTAL_BACKUP_DEVICE=/dev/disk/by-id/scsi-0HC_Volume_${volume_id}" \
      /usr/local/sbin/rental-host-bootstrap "${bundle_mode[@]}" ||
    note_drift "host configuration"
fi

if ((drift == 1)); then
  printf 'Reconciliation found drift\n' >&2
  exit 2
fi
printf 'Hetzner production host is reconciled; no delete operations are implemented\n'
