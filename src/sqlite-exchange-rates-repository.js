import { compatibleExchangeRateSnapshot } from "./exchange-rates.js";
import {
  parseStoredJson,
  runRepositoryTransaction,
  serializeJson,
} from "./sqlite-repository-values.js";

export class SqliteExchangeRatesRepository {
  constructor(database) {
    this.database = database;
    this.selectSnapshot = database.prepare(
      "SELECT snapshot_json FROM exchange_rate_state WHERE singleton = 1",
    );
    this.upsertSnapshot =
      database.prepare(`INSERT INTO exchange_rate_state(singleton, snapshot_json) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET snapshot_json = excluded.snapshot_json`);
  }

  load() {
    const stored = this.selectSnapshot.get();
    if (!stored) return undefined;
    const snapshot = parseStoredJson(
      stored.snapshot_json,
      "exchange-rate snapshot",
    );
    if (!compatibleExchangeRateSnapshot(snapshot)) {
      const error = new Error("Stored exchange-rate snapshot is incompatible");
      error.code = "ERR_STATE_DATABASE_DOMAIN_INVALID";
      throw error;
    }
    return snapshot;
  }

  save(snapshot, { transaction = true } = {}) {
    if (!compatibleExchangeRateSnapshot(snapshot))
      throw new TypeError("Exchange-rate snapshot has an incompatible schema");
    return runRepositoryTransaction(
      this.database,
      "exchange_rates_save",
      transaction,
      () => {
        this.upsertSnapshot.run(
          serializeJson(snapshot, "Exchange-rate snapshot"),
        );
        return snapshot;
      },
    );
  }

  importState(snapshot, options) {
    return this.save(snapshot, options);
  }
}
