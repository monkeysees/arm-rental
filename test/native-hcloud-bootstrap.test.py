#!/usr/bin/env python3
"""Provider reconciliation and sanitized bootstrap transfer, using local fake peers."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = ROOT / "infra/hcloud/bootstrap.sh"
MUTATIONS = r"\b(create|update|attach|replace-rules|apply-to-resource|enable-protection)\b"

HCLOUD = r'''#!/usr/bin/env bash
set -eu
printf 'hcloud %s\n' "$*" >>"$FAKE_LOG"
kind=${1:-}
action=${2:-}
labels='"labels":{"repository":"rental-apartments","role":"application","environment":"production"}'
if [[ $action == list ]]; then
  if [[ $FAKE_SCENARIO == missing ]]; then printf '[]\n'; exit 0; fi
  if [[ $FAKE_SCENARIO == create && ! -e $FAKE_STATE/$kind ]]; then
    printf '[]\n'
    exit 0
  fi
  case $kind in
    ssh-key)
      printf '[{"id":1,"name":"rental-apartments-production-ssh","public_key":"ssh-ed25519 AAAATEST operator@example",%s}]\n' "$labels"
      ;;
    firewall)
      if [[ $FAKE_SCENARIO == drift ]]; then
        rules='[]'; applied='[]'
      else
        rules='[{"direction":"in","protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"],"description":"Key-only SSH"}]'
        applied='[{"type":"server","server":{"id":4}}]'
        if [[ $FAKE_SCENARIO == create && ! -e $FAKE_STATE/server ]]; then applied='[]'; fi
      fi
      printf '[{"id":2,"name":"rental-apartments-production-firewall","rules":%s,"applied_to":%s,%s}]\n' "$rules" "$applied" "$labels"
      ;;
    volume)
      server=4
      [[ $FAKE_SCENARIO == drift ]] && server=null
      [[ $FAKE_SCENARIO == create && ! -e $FAKE_STATE/server ]] && server=null
      printf '[{"id":3,"name":"rental-apartments-production-backups","size":20,"location":{"name":"nbg1"},"server":%s,"protection":{"delete":true},%s}]\n' "$server" "$labels"
      ;;
    server)
      duplicate=''
      if [[ $FAKE_SCENARIO == duplicate ]]; then
        duplicate=',{"id":5,"name":"other-server","server_type":{"name":"cx23"},"location":{"name":"nbg1"},"image":{"id":12345},"public_net":{"ipv4":{"ip":"192.0.2.11"}},"protection":{"delete":true,"rebuild":true},'"$labels"'}'
      fi
      printf '[{"id":4,"name":"rental-apartments-production","server_type":{"name":"cx23"},"location":{"name":"nbg1"},"image":{"id":12345},"public_net":{"ipv4":{"ip":"192.0.2.10"}},"protection":{"delete":true,"rebuild":true},%s}%s]\n' "$labels" "$duplicate"
      ;;
  esac
  exit 0
fi
if [[ $FAKE_SCENARIO == create && $action == create ]]; then
  if [[ $kind == server ]]; then
    previous=
    for argument in "$@"; do
      if [[ $previous == --user-data-from-file ]]; then
        cp "$argument" "$FAKE_STATE/user-data.yaml"
      fi
      previous=$argument
    done
  fi
  touch "$FAKE_STATE/$kind"
  printf '{"id":99}\n'
  exit 0
fi
if [[ $action == describe ]]; then
  if [[ $kind == server ]]; then
    protection=true
    [[ $FAKE_SCENARIO == drift ]] && protection=false
    printf '{"id":4,"name":"rental-apartments-production","public_net":{"ipv4":{"ip":"192.0.2.10"}},"protection":{"delete":%s,"rebuild":%s}}\n' "$protection" "$protection"
  else
    protection=true
    [[ $FAKE_SCENARIO == drift ]] && protection=false
    server=4
    [[ $FAKE_SCENARIO == drift ]] && server=null
    printf '{"id":3,"name":"rental-apartments-production-backups","server":%s,"protection":{"delete":%s}}\n' "$server" "$protection"
  fi
fi
'''
SSH = r'''#!/usr/bin/env bash
set -eu
printf 'ssh %s\n' "$*" >>"$FAKE_LOG"
if [[ "$*" == *rental-host-bootstrap* ]]; then
  tar --extract --gzip --directory "$FAKE_BUNDLE_DIR" --file -
fi
'''


class BootstrapTests(unittest.TestCase):
    def setup_host(self, scenario="converged"):
        temporary = tempfile.TemporaryDirectory(prefix="rental-hcloud-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "commands.log"
        self.secret = self.root / "production.env"
        public_key = self.root / "id_ed25519.pub"
        public_key.write_text("ssh-ed25519 AAAATEST operator@example\n")
        self.write_secret("never-print-this-ghcr-token")
        for name, script in (("hcloud", HCLOUD), ("ssh", SSH)):
            target = self.bin / name
            target.write_text(script)
            target.chmod(0o755)
        self.environment = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FAKE_LOG": str(self.log),
            "FAKE_BUNDLE_DIR": str(self.root),
            "FAKE_STATE": str(self.root),
            "FAKE_SCENARIO": scenario,
            "HCLOUD_SERVER_TYPE": "cx23",
            "HCLOUD_LOCATION": "nbg1",
            "HCLOUD_IMAGE_ID": "12345",
            "HCLOUD_VOLUME_SIZE_GB": "20",
            "HCLOUD_SSH_PUBLIC_KEY_FILE": str(public_key),
            "HCLOUD_INITIAL_SECRET_FILE": str(self.secret),
        }

    def write_secret(self, token):
        self.secret.write_text(
            "TELEGRAM_BOT_TOKEN=never-print-this-token\n"
            "TELEGRAM_OWNER_ID=123\n"
            "GHCR_IMAGE_REPOSITORY=ghcr.io/example/rental\n"
            "GHCR_USERNAME=reader\n"
            f"GHCR_READ_TOKEN={token}\n"
        )
        self.secret.chmod(0o600)

    def execute(self, *arguments, status=0):
        result = subprocess.run(
            [str(BOOTSTRAP), *arguments], cwd=ROOT, env=self.environment,
            text=True, capture_output=True, timeout=45,
        )
        self.assertEqual(result.returncode, status, result.stdout + result.stderr)
        commands = self.log.read_text() if self.log.exists() else ""
        self.assertNotIn("never-print-this", commands + result.stdout + result.stderr)
        return result, commands

    def test_check_transfers_sanitized_bundle_without_mutation(self):
        self.setup_host()
        _, commands = self.execute("--check")
        self.assertIn("hcloud server list --output json", commands)
        self.assertRegex(commands, r"ssh .*rental-host-bootstrap --bundle --check")
        self.assertNotRegex(commands, MUTATIONS)
        for filename, marker in (("deploy-launcher", "BOOTSTRAP_DEPLOY"),
                                 ("rentalctl-launcher", "BOOTSTRAP_RENTALCTL")):
            self.assertIn(marker, (self.root / "ops" / filename).read_text())

    def test_reconciles_drift_in_safe_order(self):
        self.setup_host("drift")
        _, commands = self.execute()
        self.assertEqual(len(re.findall(r"rental-host-bootstrap --bundle$", commands, re.M)), 2)
        order = [commands.index(part) for part in (
            "firewall replace-rules", "volume attach", "firewall apply-to-resource",
            "server enable-protection", "volume enable-protection",
        )]
        self.assertEqual(order, sorted(order))
        self.assertIn("server enable-protection rental-apartments-production delete rebuild", commands)
        self.assertIn("volume enable-protection rental-apartments-production-backups delete", commands)
        self.assertNotRegex(commands, r"enable-protection .* --delete")
        self.assertNotRegex(commands, r"(?m)^hcloud \S+ (delete|rebuild)\b")

    def test_first_create_is_idempotent_on_second_reconciliation(self):
        self.setup_host("create")
        _, commands = self.execute()
        order = [commands.index(part) for part in (
            "ssh-key create", "firewall create", "volume create", "server create",
        )]
        self.assertEqual(order, sorted(order))
        self.assertIn("sudo env RENTAL_BACKUP_DEVICE=/dev/disk/by-id/scsi-0HC_Volume_3 "
                      "/usr/local/sbin/rental-host-bootstrap --bundle", commands)
        self.assertEqual(len(re.findall(r"rental-host-bootstrap --bundle$", commands, re.M)), 2)
        user_data = (self.root / "user-data.yaml").read_bytes()
        self.assertLessEqual(len(user_data), 32768)
        self.assertIn(b"/usr/local/sbin/rental-host-bootstrap", user_data)
        self.assertNotIn(b"BOOTSTRAP_DEPLOY", user_data)
        self.log.write_text("")
        _, commands = self.execute()
        self.assertNotRegex(commands, MUTATIONS)

    def test_dry_run_has_no_mutations(self):
        self.setup_host("missing")
        result, commands = self.execute("--dry-run")
        self.assertIn("PLAN create server", result.stdout)
        self.assertNotRegex(commands, MUTATIONS)

    def test_oversized_user_data_rejected_before_provider_mutation(self):
        self.setup_host("missing")
        self.write_secret("x" * 32768)
        result, commands = self.execute(status=65)
        self.assertIn("exceeds Hetzner user-data limit", result.stderr)
        self.assertNotRegex(commands, MUTATIONS)

    def test_ambiguous_resource_selection_fails_closed(self):
        self.setup_host("duplicate")
        result, commands = self.execute("--check", status=65)
        self.assertIn("Refusing ambiguous server reconciliation", result.stderr)
        self.assertNotRegex(commands, r"\b(delete|create|update|attach)\b")

    def test_host_security_and_receipt_contract(self):
        bootstrap = BOOTSTRAP.read_text()
        cloud_init = (ROOT / "infra/hcloud/cloud-init.yaml").read_text()
        helper = (ROOT / "infra/hcloud/host-bootstrap.sh").read_text()
        journald = (ROOT / "infra/hcloud/journald.conf").read_text()
        self.assertIn("COPYFILE_DISABLE=1 LC_ALL=C tar --no-xattrs", bootstrap)
        for value in ("ssh_pwauth: false", "disable_root: true"):
            self.assertIn(value, cloud_init)
        for value in (
            "normalized_mode=${mode#0}", "remove_appledouble_files", "ops_file_manifest",
            "sha256sum --zero", "/etc/rental-apartments/env", "chmod 0600",
            "ensure_directory /var/lib/rental-apartments-ops 0750 root:rental-deploy",
            "install -d -m 0750 -o root -g rental-deploy /var/lib/rental-apartments-ops",
            "UUID=$uuid", "--opt o=bind", "bootstrap-receipt.json",
            "systemctl enable docker.service rental-apartments.service",
            "systemctl is-enabled --quiet", "systemctl is-active --quiet",
        ):
            self.assertIn(value, helper)
        for value in ("Storage=persistent", "MaxRetentionSec=14day", "RateLimitBurst=10000"):
            self.assertIn(value, journald)


if __name__ == "__main__":
    unittest.main(verbosity=2)
