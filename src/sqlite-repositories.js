import { SqliteApartmentsRepository } from "./sqlite-apartments-repository.js";
import { SqliteChannelDeliveriesRepository } from "./sqlite-channel-deliveries-repository.js";
import { SqliteExchangeRatesRepository } from "./sqlite-exchange-rates-repository.js";
import { SqlitePrivateDeliveriesRepository } from "./sqlite-private-deliveries-repository.js";
import { SqliteTelegramRepository } from "./sqlite-telegram-repository.js";

export function createSqliteRepositories(
  database,
  { listUrlTemplate, channelId = null },
) {
  return {
    apartments: new SqliteApartmentsRepository(database, { listUrlTemplate }),
    privateDeliveries: new SqlitePrivateDeliveriesRepository(database, {
      listUrlTemplate,
    }),
    channelDeliveries: channelId
      ? new SqliteChannelDeliveriesRepository(database, {
          listUrlTemplate,
          channelId,
        })
      : null,
    telegram: new SqliteTelegramRepository(database),
    exchangeRates: new SqliteExchangeRatesRepository(database),
  };
}
