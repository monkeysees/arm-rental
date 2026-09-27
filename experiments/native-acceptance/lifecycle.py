"""Offline lifecycle acceptance for the packaged production Rust application."""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import re
import sqlite3

from common import BACKUP_PATH, DATA_PATH, Harness


def _json(result) -> dict:
    return json.loads(result.stdout)


def _seed(harness: Harness, volume: str, fixture: Path) -> None:
    with harness.host_access(volume) as root:
        database = root / "state.sqlite3"
        with sqlite3.connect(database) as connection:
            connection.executescript(fixture.read_text(encoding="utf-8"))
        database.chmod(0o600)


def _state(harness: Harness, volume: str) -> dict:
    with harness.host_access(volume) as root:
        database = root / "state.sqlite3"
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row
            app_id = connection.execute("PRAGMA application_id").fetchone()[0]
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            metadata = dict(connection.execute(
                "SELECT database_id,list_url_template,channel_id FROM application_metadata WHERE singleton=1"
            ).fetchone())
            offset = connection.execute("SELECT update_offset FROM telegram_state WHERE singleton=1").fetchone()[0]
            apartments = [row[0] for row in connection.execute("SELECT item_id FROM apartments ORDER BY item_id")]
            apartment_kinds = {
                row[0]: row[1]
                for row in connection.execute("SELECT item_id,kind FROM apartments ORDER BY item_id")
            }
            recipients = [row[0] for row in connection.execute("SELECT recipient_id FROM private_recipients ORDER BY recipient_id")]
            decisions = [
                {"recipientId": row[0], "itemId": row[1], "status": row[2], "decidedAt": row[3]}
                for row in connection.execute(
                    "SELECT recipient_id,item_id,status,decided_at FROM private_delivery_decisions ORDER BY recipient_id,item_id"
                )
            ]
            migrations = [row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")]
            snapshot_row = connection.execute(
                "SELECT snapshot_json FROM exchange_rate_state WHERE singleton=1"
            ).fetchone()
            snapshot = json.loads(snapshot_row[0]) if snapshot_row else None
            pending = connection.execute(
                "SELECT compaction_pending FROM application_metadata WHERE singleton=1"
            ).fetchone()[0]
        return {
            "applicationId": app_id,
            "currentVersion": version,
            "databaseId": metadata["database_id"],
            "listUrlTemplate": metadata["list_url_template"],
            "channelId": metadata["channel_id"],
            "updateOffset": offset,
            "apartmentIds": apartments,
            "apartmentKinds": apartment_kinds,
            "recipientIds": recipients,
            "decisions": decisions,
            "schemaMigrationVersions": migrations,
            "exchangeRates": {
                "effectiveDate": snapshot["effectiveDate"],
                "usdAmount": snapshot["rates"]["USD"]["amount"],
                "usdRate": snapshot["rates"]["USD"]["rate"],
            } if snapshot else None,
            "compactionPending": pending,
        }


def _expect_failure(result, text: str | None = None) -> None:
    assert result.returncode != 0, f"command unexpectedly passed: {result.stdout}"
    if text is not None:
        assert text in result.stderr, f"expected {text!r}, got {result.stderr!r}"


def _database_hash(harness: Harness, volume: str) -> str:
    with harness.host_access(volume) as root:
        return sha256((root / "state.sqlite3").read_bytes()).hexdigest()


def _all_rows(harness: Harness, volume: str) -> dict[str, list[dict]]:
    """Capture every application table and column in a stable row order."""
    with harness.host_access(volume) as root:
        database = root / "state.sqlite3"
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row
            tables = [
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_schema WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name"
                )
            ]
            result = {}
            for table in tables:
                # Table names come from SQLite's own schema, not user input.
                rows = [dict(row) for row in connection.execute(f'SELECT * FROM "{table}"')]
                rows.sort(key=lambda row: json.dumps(row, sort_keys=True, ensure_ascii=False))
                result[table] = rows
            return result


def _normalized_rows(rows: dict[str, list[dict]], source_version: int, *, frozen: bool) -> dict[str, list[dict]]:
    """Ignore only metadata generated at upgrade time, retaining older rows."""
    copy = {table: [dict(row) for row in values] for table, values in rows.items()}
    for row in copy["schema_migrations"]:
        if row["version"] <= source_version:
            continue
        if frozen:
            assert row["applied_at"] == "<migration-time>"
            assert row["source_revision"] == "<migration-source>"
        else:
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", row["applied_at"])
            assert isinstance(row["source_revision"], str) and row["source_revision"]
        row["applied_at"] = "<migration-time>"
        row["source_revision"] = "<migration-source>"
    return copy


def _assert_frozen_rows(actual: dict[str, list[dict]], frozen: dict[str, list[dict]], source_version: int) -> None:
    assert set(actual) == set(frozen), f"schema {source_version}: table set differs"
    actual = _normalized_rows(actual, source_version, frozen=False)
    frozen = _normalized_rows(frozen, source_version, frozen=True)
    for table in sorted(frozen):
        assert actual[table] == frozen[table], f"schema {source_version}: {table} rows differ from frozen Node baseline"


def run_lifecycle(harness: Harness, fixtures_dir: Path) -> dict:
    """Return concise evidence after asserting every lifecycle boundary."""
    expected = json.loads((fixtures_dir / "expected.json").read_text(encoding="utf-8"))["schema"]
    required = {
        "applicationId", "currentVersion", "schemaMigrationVersions", "databaseId",
        "listUrlTemplate", "channelId", "updateOffset", "apartmentIds",
        "apartmentKinds", "recipientIds", "decisions", "exchangeRates",
        "compactionPending",
    }
    assert required <= expected.keys(), "incomplete frozen schema expectations"
    assert expected["currentVersion"] == 6
    frozen_rows = expected["rowsBySourceVersion"]
    assert set(frozen_rows) == {"1", "2", "3", "4", "5"}, "missing frozen complete-row expectations"
    checks: list[str] = []

    # Fresh initialization and maintenance operate against the actual image
    # with no network and with only the production UID's writable mounts.
    data = harness.new_volume()
    backup = harness.new_volume()
    _expect_failure(harness.run_app(["state:validate"], data_volume=data, check=False), "ERR_STATE_DATABASE_ABSENT")
    _expect_failure(harness.run_app(["serve"], data_volume=data, check=False, timeout=20), "ERR_STATE_DATABASE_ABSENT")
    initialized = _json(harness.run_app(["state:init"], data_volume=data))
    assert initialized["database"]["userVersion"] == 6
    _expect_failure(harness.run_app(["state:init"], data_volume=data, check=False), "ERR_STATE_ALREADY_INITIALIZED")
    validated = _json(harness.run_app(["state:validate"], data_volume=data))
    assert initialized == validated
    inspection = _json(harness.run_app(["state:inspect"], data_volume=data))
    assert inspection == {"stateBackend": "sqlite", "stateSchema": 6}
    checks += ["fail-closed-absent-state", "fresh-init", "schema-validation", "read-only-inspection"]

    report = _json(harness.run_app(["maintenance:report"], data_volume=data))
    assert report["stateFiles"][0]["schemaVersion"] == 6
    disk = _json(harness.run_app(
        ["storage:check"], data_volume=data, env={"DISK_FREE_WARNING_PERCENT": "1"}
    ))
    assert disk["status"] == "ok"
    low_disk = harness.run_app(
        ["storage:check"], data_volume=data,
        env={"DISK_FREE_WARNING_PERCENT": "99"}, check=False,
    )
    assert low_disk.returncode == 2
    assert _json(low_disk)["status"] == "warning"
    checks += ["maintenance-report", "live-safe-disk-check", "low-disk-warning-exit"]

    snapshot = _json(harness.run_app(["backup:create"], data_volume=data, backup_volume=backup))["snapshot"]
    assert snapshot.startswith(BACKUP_PATH + "/")
    archive = _json(harness.run_app(["backup:validate", "--snapshot", snapshot], data_volume=data, backup_volume=backup))
    assert archive["summary"] == validated
    restored = _json(harness.run_app(["backup:restore", "--snapshot", snapshot], data_volume=data, backup_volume=backup))
    assert restored["summary"] == validated
    checks += ["backup-create", "backup-validate", "backup-restore"]

    # A corrupted manifest must be refused before touching installed state.
    before = _state(harness, data)
    with harness.host_access(backup) as root:
        manifest = root / snapshot.removeprefix(BACKUP_PATH + "/") / "manifest.json"
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["hashes"] = {}
        manifest.write_text(json.dumps(payload), encoding="utf-8")
        manifest.chmod(0o600)
    _expect_failure(harness.run_app(["backup:restore", "--snapshot", snapshot], data_volume=data, backup_volume=backup, check=False))
    assert _state(harness, data) == before
    checks.append("corrupt-backup-rejected-without-mutation")

    # These fixtures are independent, frozen Node-baseline SQLite histories.
    # The acceptance process never regenerates them from the Rust candidate.
    populated = None
    for version in range(1, 6):
        fixture = fixtures_dir / f"schema-v{version}-populated.sql"
        assert fixture.is_file(), f"missing frozen schema {version} fixture"
        legacy = harness.new_volume()
        _seed(harness, legacy, fixture)
        with harness.host_access(legacy) as root:
            with sqlite3.connect(root / "state.sqlite3") as connection:
                assert connection.execute("PRAGMA user_version").fetchone()[0] == version
        result = _json(harness.run_app(["state:validate"], data_volume=legacy))
        assert result["database"]["userVersion"] == 6
        state = _state(harness, legacy)
        for key in required:
            assert state[key] == expected[key], f"schema {version}: {key}: {state[key]!r} != {expected[key]!r}"
        assert state["schemaMigrationVersions"] == [1, 2, 3, 4, 5, 6]
        _assert_frozen_rows(_all_rows(harness, legacy), frozen_rows[str(version)], version)
        checks.append(f"populated-schema-{version}-upgrade")
        if version == 5:
            populated = legacy

    assert populated is not None
    populated_rows = _all_rows(harness, populated)
    populated_backup = harness.new_volume()
    populated_summary = _json(harness.run_app(["state:validate"], data_volume=populated))
    populated_snapshot = _json(harness.run_app(
        ["backup:create"], data_volume=populated, backup_volume=populated_backup
    ))["snapshot"]
    verified_snapshot = _json(harness.run_app(
        ["backup:validate", "--snapshot", populated_snapshot],
        data_volume=populated, backup_volume=populated_backup
    ))
    assert verified_snapshot["summary"] == populated_summary
    with harness.host_access(populated) as root:
        with sqlite3.connect(root / "state.sqlite3") as connection:
            connection.execute("UPDATE telegram_state SET update_offset=999 WHERE singleton=1")
    assert _all_rows(harness, populated) != populated_rows
    restored_populated = _json(harness.run_app(
        ["backup:restore", "--snapshot", populated_snapshot],
        data_volume=populated, backup_volume=populated_backup
    ))
    assert restored_populated["summary"] == populated_summary
    assert _all_rows(harness, populated) == populated_rows, "populated restore lost or added table rows"
    checks.append("populated-backup-restore-exact-rows")
    with harness.host_access(populated_backup) as root:
        manifest = root / populated_snapshot.removeprefix(BACKUP_PATH + "/") / "manifest.json"
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["hashes"] = {}
        manifest.write_text(json.dumps(payload), encoding="utf-8")
        manifest.chmod(0o600)
    _expect_failure(harness.run_app(
        ["backup:restore", "--snapshot", populated_snapshot],
        data_volume=populated, backup_volume=populated_backup, check=False
    ))
    assert _all_rows(harness, populated) == populated_rows
    checks.append("populated-corrupt-backup-rejected-without-mutation")

    # Target identity, schema version, database mode, and configuration fail
    # closed. None may reinterpret a populated database as a fresh one.
    negative = json.loads((fixtures_dir / "expected.json").read_text(encoding="utf-8"))["negative"]
    for label, sql, error in [
        ("wrong-target", f"UPDATE application_metadata SET list_url_template='{negative['wrongListUrlTemplate']}'", "ERR_STATE_DATABASE_TARGET"),
        ("newer-schema", f"PRAGMA user_version={negative['newerSchemaVersion']}", "ERR_STATE_DATABASE_SCHEMA_NEWER"),
        ("wrong-application-id", f"PRAGMA application_id={negative['wrongApplicationId']}", "ERR_STATE_DATABASE_APPLICATION_ID"),
    ]:
        rejected = harness.new_volume()
        _seed(harness, rejected, fixtures_dir / "schema-v5-populated.sql")
        with harness.host_access(rejected) as root:
            with sqlite3.connect(root / "state.sqlite3") as connection:
                connection.execute(sql)
        original = _database_hash(harness, rejected)
        _expect_failure(harness.run_app(["state:validate"], data_volume=rejected, check=False), error)
        assert _database_hash(harness, rejected) == original, f"{label} rejection changed state"
        checks.append(f"{label}-rejected-without-mutation")
    unsafe = harness.new_volume()
    _seed(harness, unsafe, fixtures_dir / "schema-v5-populated.sql")
    with harness.host_access(unsafe) as root:
        database = root / "state.sqlite3"
        database.chmod(0o644)
    _expect_failure(harness.run_app(["state:validate"], data_volume=unsafe, check=False), "ERR_STATE_DATABASE_MODE")
    _expect_failure(harness.run_app(
        ["maintenance:report"], data_volume=data,
        env={"TELEGRAM_ACCESS_MODE": "allowlist", "TELEGRAM_ALLOWED_USER_IDS": ""}, check=False
    ), "Invalid Telegram access policy")
    checks += ["unsafe-mode-rejected", "bad-config-rejected"]

    # A failure at the final migration ledger write must roll back every
    # earlier migration in the same transaction, then permit a clean retry.
    interrupted = harness.new_volume()
    _seed(harness, interrupted, fixtures_dir / "schema-v1-populated.sql")
    with harness.host_access(interrupted) as root:
        with sqlite3.connect(root / "state.sqlite3") as connection:
            connection.execute("CREATE TRIGGER fail_late BEFORE INSERT ON schema_migrations WHEN NEW.version=6 BEGIN SELECT RAISE(ABORT,'injected late ledger failure'); END")
    _expect_failure(harness.run_app(["state:validate"], data_volume=interrupted, check=False), "injected late ledger failure")
    with harness.host_access(interrupted) as root:
        with sqlite3.connect(root / "state.sqlite3") as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == 1
            assert connection.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == 1
            connection.execute("DROP TRIGGER fail_late")
    assert _json(harness.run_app(["state:validate"], data_volume=interrupted))["database"]["userVersion"] == 6
    assert _state(harness, interrupted)["apartmentIds"] == expected["apartmentIds"]
    checks.append("migration-transaction-rollback-and-retry")

    # A legacy timestamp outside the exact millisecond domain must reject the
    # entire upgrade, including schema ledger writes and retained decisions.
    noncanonical = harness.new_volume()
    _seed(harness, noncanonical, fixtures_dir / "schema-v1-populated.sql")
    with harness.host_access(noncanonical) as root:
        with sqlite3.connect(root / "state.sqlite3") as connection:
            connection.execute(
                "UPDATE private_delivery_decisions SET decided_at=? WHERE item_id='100001'",
                ("2026-01-01T00:00:00Z",),
            )
    invalid_rows = _all_rows(harness, noncanonical)
    _expect_failure(harness.run_app(["state:validate"], data_volume=noncanonical, check=False))
    assert _all_rows(harness, noncanonical) == invalid_rows
    with harness.host_access(noncanonical) as root:
        with sqlite3.connect(root / "state.sqlite3") as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == 1
    checks.append("noncanonical-decision-upgrade-rejected-atomically")

    # Freeze JavaScript Date.parse's full signed-year millisecond range; it is
    # wider than Python datetime and previously exposed a migration mismatch.
    for label, stamp, millis in [
        ("expanded-positive", "+275760-09-13T00:00:00.000Z", 8640000000000000),
        ("expanded-negative", "-000001-12-31T23:59:59.999Z", -62167219200001),
    ]:
        expanded = harness.new_volume()
        _seed(harness, expanded, fixtures_dir / "schema-v1-populated.sql")
        with harness.host_access(expanded) as root:
            with sqlite3.connect(root / "state.sqlite3") as connection:
                connection.execute(
                    "UPDATE private_delivery_decisions SET decided_at=? WHERE item_id='100001'",
                    (stamp,),
                )
        assert _json(harness.run_app(["state:validate"], data_volume=expanded))["database"]["userVersion"] == 6
        decisions = _state(harness, expanded)["decisions"]
        assert next(row for row in decisions if row["itemId"] == "100001")["decidedAt"] == millis
        assert _state(harness, expanded)["updateOffset"] == 42
        checks.append(f"{label}-decision-upgrade-exact-millisecond")

    # Force installation to fail after the archive has passed validation. A
    # blocked nested sentinel target must leave the prior live files in place.
    restore_data = harness.new_volume()
    restore_backup = harness.new_volume()
    restore_env = {"TELEGRAM_STATE_FILE": DATA_PATH + "/nested/telegram.json"}
    initialized_restore = _json(harness.run_app(
        ["state:init"], data_volume=restore_data, backup_volume=restore_backup,
        env=restore_env,
    ))
    with harness.host_access(restore_data) as root:
        (root / "apartments.json").write_text("snapshot sentinel", encoding="utf-8")
        (root / "apartments.json").chmod(0o600)
        (root / "nested").mkdir(mode=0o700)
        (root / "nested/telegram.json").write_text("snapshot telegram", encoding="utf-8")
        (root / "nested/telegram.json").chmod(0o600)
    recovery_point = _json(harness.run_app(
        ["backup:create"], data_volume=restore_data, backup_volume=restore_backup,
        env=restore_env,
    ))["snapshot"]
    with harness.host_access(restore_data) as root:
        (root / "apartments.json").write_text("live sentinel", encoding="utf-8")
        (root / "nested/telegram.json").unlink()
        (root / "nested").rmdir()
        (root / "nested").write_text("blocked nested target", encoding="utf-8")
    _expect_failure(harness.run_app(
        ["backup:restore", "--snapshot", recovery_point], data_volume=restore_data,
        backup_volume=restore_backup, env=restore_env, check=False,
    ))
    with harness.host_access(restore_data) as root:
        assert (root / "apartments.json").read_text(encoding="utf-8") == "live sentinel"
        assert (root / "nested").read_text(encoding="utf-8") == "blocked nested target"
    assert _json(harness.run_app(
        ["state:validate"], data_volume=restore_data, env=restore_env,
    )) == initialized_restore
    checks.append("restore-install-failure-preserves-live-files")

    return {
        "checks": checks,
        "imageId": harness.image_id,
        "binarySha256": harness.binary_sha256,
        "sourceRevision": harness.source_revision,
        "sourceDirty": harness.source_dirty,
        "fixtureSha256": {
            path.name: sha256(path.read_bytes()).hexdigest()
            for path in sorted(fixtures_dir.glob("schema-v*-populated.sql"))
        },
        "populatedTablesChecked": sorted(populated_rows),
    }
