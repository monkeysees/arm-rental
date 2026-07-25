#!/usr/bin/env bash
set -Eeuo pipefail

MODE=apply
BUNDLE=0
while (($#)); do
  case $1 in
    --check) MODE=check ;;
    --bundle) BUNDLE=1 ;;
    *)
      printf 'Usage: rental-host-bootstrap [--check] [--bundle]\n' >&2
      exit 64
      ;;
  esac
  shift
done

[[ $EUID == 0 ]] || {
  printf 'Host bootstrap must run as root\n' >&2
  exit 77
}

SOURCE_ROOT=/usr/local/lib/rental-apartments-bootstrap
TEMPORARY_DIRECTORY=
cleanup() {
  if [[ -n $TEMPORARY_DIRECTORY && -d $TEMPORARY_DIRECTORY ]]; then
    rm -rf -- "$TEMPORARY_DIRECTORY"
  fi
}
trap cleanup EXIT

if ((BUNDLE == 1)); then
  TEMPORARY_DIRECTORY=$(mktemp -d /run/rental-host-bootstrap.XXXXXX)
  tar --extract --gzip --directory "$TEMPORARY_DIRECTORY" --file -
  SOURCE_ROOT=$TEMPORARY_DIRECTORY
fi

drift=0
changed=0
report_drift() {
  printf 'DRIFT %s\n' "$1" >&2
  drift=1
}

ensure_directory() {
  local path=$1 mode=$2 owner=$3
  if [[ ! -d $path ]] ||
    [[ $(stat --format='%a:%U:%G' "$path" 2>/dev/null || true) != "$mode:$owner" ]]; then
    if [[ $MODE == check ]]; then
      report_drift "$path"
    else
      install -d -m "$mode" -o "${owner%:*}" -g "${owner#*:}" "$path"
      changed=1
    fi
  fi
}

install_file() {
  local source=$1 target=$2 mode=$3
  if [[ ! -f $target ]] || ! cmp --silent "$source" "$target" ||
    [[ $(stat --format='%a:%U:%G' "$target" 2>/dev/null || true) != "$mode:root:root" ]]; then
    if [[ $MODE == check ]]; then
      report_drift "$target"
    else
      install -D -m "$mode" -o root -g root "$source" "$target"
      changed=1
    fi
  fi
}

required_packages=(ca-certificates curl docker.io docker-compose-v2 git jq lnav unattended-upgrades)
missing_packages=()
for package in "${required_packages[@]}"; do
  dpkg-query --show --showformat='${Status}' "$package" 2>/dev/null |
    grep --quiet 'ok installed' || missing_packages+=("$package")
done
if ((${#missing_packages[@]})); then
  if [[ $MODE == check ]]; then
    report_drift "packages:${missing_packages[*]}"
  else
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      "${missing_packages[@]}"
    changed=1
  fi
fi

if ! id rental-deploy >/dev/null 2>&1; then
  if [[ $MODE == check ]]; then
    report_drift "user:rental-deploy"
  else
    useradd --create-home --shell /bin/bash --groups docker,systemd-journal rental-deploy
    changed=1
  fi
elif [[ $MODE == apply ]]; then
  usermod --append --groups docker,systemd-journal rental-deploy
fi
if id rental-deploy >/dev/null 2>&1; then
  deployment_groups=$(id --name --groups rental-deploy)
  for required_group in docker systemd-journal; do
    grep --quiet --word-regexp "$required_group" <<<"$deployment_groups" ||
      {
        if [[ $MODE == check ]]; then
          report_drift "user-group:rental-deploy:$required_group"
        fi
      }
  done
fi

ensure_directory /etc/rental-apartments 0700 root:root
ensure_directory /opt/rental-apartments 0750 rental-deploy:rental-deploy
ensure_directory /var/lib/rental-apartments-ops 0750 rental-deploy:rental-deploy
ensure_directory /var/lib/rental-apartments/releases 0750 rental-deploy:rental-deploy
ensure_directory /var/log/journal 2755 root:systemd-journal
ensure_directory /etc/systemd/journald.conf.d 0755 root:root
ensure_directory /etc/ssh/sshd_config.d 0755 root:root
ensure_directory /etc/apt/apt.conf.d 0755 root:root
ensure_directory /etc/apt/preferences.d 0755 root:root
ensure_directory /usr/local/lib/rental-apartments-bootstrap 0755 root:root

if [[ -e /etc/rental-apartments/env ]]; then
  if [[ -L /etc/rental-apartments/env || ! -f /etc/rental-apartments/env ]]; then
    printf 'Refusing unsafe production secret path\n' >&2
    exit 65
  fi
  if [[ $(stat --format='%a:%U:%G' /etc/rental-apartments/env) != 600:root:root ]]; then
    if [[ $MODE == check ]]; then
      report_drift /etc/rental-apartments/env
    else
      chown root:root /etc/rental-apartments/env
      chmod 0600 /etc/rental-apartments/env
    fi
  fi
fi

root_bytes=$(findmnt --bytes --noheadings --output SIZE /)
requested_max=${RENTAL_JOURNAL_MAX_BYTES:-1073741824}
[[ $requested_max =~ ^[1-9][0-9]*$ ]]
ten_percent=$((root_bytes / 10))
((requested_max <= ten_percent)) || requested_max=$ten_percent
journal_source="$SOURCE_ROOT/infra/hcloud/journald.conf"
journal_rendered=$(mktemp /run/rental-journald.XXXXXX)
sed "s/^SystemMaxUse=.*/SystemMaxUse=$requested_max/" "$journal_source" >"$journal_rendered"
install_file "$journal_rendered" /etc/systemd/journald.conf.d/60-rental-apartments.conf 0644
rm -- "$journal_rendered"

ssh_config=$(mktemp /run/rental-sshd.XXXXXX)
printf '%s\n' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'PermitRootLogin no' >"$ssh_config"
install_file "$ssh_config" /etc/ssh/sshd_config.d/60-rental-apartments.conf 0644
rm -- "$ssh_config"

unattended_config=$(mktemp /run/rental-unattended.XXXXXX)
printf '%s\n' \
  'APT::Periodic::Update-Package-Lists "1";' \
  'APT::Periodic::Unattended-Upgrade "1";' >"$unattended_config"
install_file "$unattended_config" /etc/apt/apt.conf.d/20auto-upgrades 0644
rm -- "$unattended_config"

# Ubuntu's signed archive remains the only package source. Pinning the installed
# Docker and Compose majors permits security/patch updates without silently
# crossing the reviewed runtime compatibility boundary.
container_pins=$(mktemp /run/rental-container-pins.XXXXXX)
container_versions_complete=1
for package in docker.io docker-compose-v2; do
  package_version=$(dpkg-query --show --showformat='${Version}' "$package" 2>/dev/null || true)
  if [[ -z $package_version ]]; then
    container_versions_complete=0
    continue
  fi
  package_major=$(sed --regexp-extended 's/^[^0-9]*([0-9]+).*/\1/' <<<"$package_version")
  printf 'Package: %s\nPin: version *%s.*\nPin-Priority: 1001\n\n' \
    "$package" "$package_major" >>"$container_pins"
done
if ((container_versions_complete == 1)); then
  install_file "$container_pins" /etc/apt/preferences.d/rental-container-majors 0644
fi
rm -- "$container_pins"

if [[ -d $SOURCE_ROOT/infra/systemd ]]; then
  while IFS= read -r unit; do
    install_file "$unit" "/etc/systemd/system/${unit##*/}" 0644
  done < <(find "$SOURCE_ROOT/infra/systemd" -maxdepth 1 -type f \
    \( -name '*.service' -o -name '*.timer' \) -print | sort)
fi
if [[ -d $SOURCE_ROOT/ops ]]; then
  if [[ $MODE == check ]]; then
    diff --brief --recursive "$SOURCE_ROOT/ops" \
      /usr/local/lib/rental-apartments-bootstrap/ops >/dev/null ||
      report_drift /usr/local/lib/rental-apartments-bootstrap/ops
  elif [[ $SOURCE_ROOT != /usr/local/lib/rental-apartments-bootstrap ]]; then
    install -d -m 0755 /usr/local/lib/rental-apartments-bootstrap/ops/lib
    find "$SOURCE_ROOT/ops" -maxdepth 1 -type f -exec install -m 0755 -o root -g root \
      {} /usr/local/lib/rental-apartments-bootstrap/ops/ \;
    find "$SOURCE_ROOT/ops/lib" -maxdepth 1 -type f -exec install -m 0644 -o root -g root \
      {} /usr/local/lib/rental-apartments-bootstrap/ops/lib/ \;
  fi
fi
if [[ -f $SOURCE_ROOT/ops/deploy-launcher ]]; then
  install_file "$SOURCE_ROOT/ops/deploy-launcher" /usr/local/sbin/rental-deploy 0755
fi
install_file "$SOURCE_ROOT/infra/hcloud/host-bootstrap.sh" \
  /usr/local/sbin/rental-host-bootstrap 0755

volume_device=${RENTAL_BACKUP_DEVICE:-}
backup_mount=/mnt/rental-apartments-backups
if [[ -n $volume_device ]]; then
  if [[ ! -b $volume_device ]]; then
    if [[ $MODE == check ]]; then
      report_drift "$volume_device"
    else
      for _attempt in {1..60}; do
        [[ -b $volume_device ]] && break
        sleep 2
      done
      [[ -b $volume_device ]] || {
        printf 'Backup volume did not appear\n' >&2
        exit 69
      }
    fi
  fi
  filesystem_type=$(blkid --output value --match-tag TYPE "$volume_device" 2>/dev/null || true)
  if [[ -z $filesystem_type && $MODE == apply ]]; then
    mkfs.ext4 -m 1 -L rental-backups "$volume_device"
    filesystem_type=ext4
  fi
  [[ $filesystem_type == ext4 ]] || {
    report_drift "backup-filesystem"
    [[ $MODE == check ]] || exit 65
  }
  uuid=$(blkid --output value --match-tag UUID "$volume_device" 2>/dev/null || true)
  fstab_entry="UUID=$uuid $backup_mount ext4 defaults,nofail,nodev,nosuid 0 2"
  ensure_directory "$backup_mount" 0750 rental-deploy:rental-deploy
  if ! grep --fixed-strings --line-regexp --quiet "$fstab_entry" /etc/fstab; then
    if [[ $MODE == check ]]; then
      report_drift /etc/fstab
    else
      printf '%s\n' "$fstab_entry" >>/etc/fstab
      changed=1
    fi
  fi
  if ! findmnt --mountpoint "$backup_mount" >/dev/null 2>&1; then
    if [[ $MODE == check ]]; then
      report_drift "$backup_mount"
    else
      mount "$backup_mount"
    fi
  fi
  if [[ $MODE == apply ]]; then
    chown rental-deploy:rental-deploy "$backup_mount"
    chmod 0750 "$backup_mount"
  fi
fi

if command -v docker >/dev/null 2>&1 && [[ -n $volume_device ]] &&
  findmnt --mountpoint "$backup_mount" >/dev/null 2>&1; then
  if ! docker volume inspect rental-apartments-backups >/dev/null 2>&1; then
    if [[ $MODE == check ]]; then
      report_drift "docker-volume:rental-apartments-backups"
    else
      docker volume create --driver local \
        --opt type=none --opt o=bind --opt "device=$backup_mount" \
        rental-apartments-backups >/dev/null
    fi
  else
    docker_binding=$(docker volume inspect \
      --format '{{.Driver}}|{{index .Options "type"}}|{{index .Options "o"}}|{{index .Options "device"}}' \
      rental-apartments-backups)
    [[ $docker_binding == "local|none|bind|$backup_mount" ]] ||
      {
        printf 'Existing Docker backup volume is not bind-backed by %s\n' "$backup_mount" >&2
        exit 65
      }
  fi
fi

if [[ $MODE == check ]]; then
  for required_unit in docker.service rental-apartments.service; do
    systemctl is-enabled --quiet "$required_unit" ||
      report_drift "enabled-unit:$required_unit"
  done
  while IFS= read -r timer; do
    timer=${timer##*/}
    systemctl is-enabled --quiet "$timer" ||
      report_drift "enabled-unit:$timer"
    systemctl is-active --quiet "$timer" ||
      report_drift "active-timer:$timer"
  done < <(find /etc/systemd/system -maxdepth 1 -name 'rental-*.timer' -type f -print | sort)
fi

if [[ $MODE == apply ]]; then
  systemctl daemon-reload
  systemctl restart systemd-journald
  systemctl reload ssh
  systemctl enable docker.service rental-apartments.service
  while IFS= read -r timer; do
    systemctl enable --now "${timer##*/}"
  done < <(find /etc/systemd/system -maxdepth 1 -name 'rental-*.timer' -type f -print | sort)
  install -d -m 0700 -o root -g root /var/lib/rental-apartments-ops
  unit_versions=$(find /etc/systemd/system -maxdepth 1 \
    \( -name 'rental-*.service' -o -name 'rental-*.timer' \) -type f -print0 |
    sort -z | xargs -0 sha256sum |
    jq -Rsc 'split("\n") | map(select(length > 0) | split("  ")) |
      map({key: (.[1] | split("/") | last), value: .[0]}) | from_entries')
  jq --null-input \
    --arg recordedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
    --arg docker "$(docker --version)" \
    --arg compose "$(docker compose version)" \
    --arg kernel "$(uname --kernel-release)" \
    --arg os "$(. /etc/os-release; printf '%s' "$PRETTY_NAME")" \
    --argjson unitVersions "$unit_versions" \
    '{schemaVersion:1,recordedAt:$recordedAt,docker:$docker,compose:$compose,
      kernel:$kernel,os:$os,unitVersions:$unitVersions}' \
    >/var/lib/rental-apartments-ops/bootstrap-receipt.json
  chmod 0600 /var/lib/rental-apartments-ops/bootstrap-receipt.json
fi

if ((drift == 1)); then
  exit 2
fi
printf 'Host bootstrap %s; changed=%s\n' "$MODE" "$changed"
