export const TELEGRAM_BOT_METADATA = Object.freeze({
  shortDescription: [
    "Квартиры и дома с List.am.",
    "Канал «Жилье в Ереване от собственников»: @yerevan_rental.",
    "Связь: @monkeysees.",
  ].join("\n"),
  description: [
    "Бот находит на List.am объявления о долгосрочной аренде квартир и домов от собственников и присылает новые подходящие варианты.",
    "",
    "Настройте тип жилья, цену в драмах, количество комнат и местоположение, затем запустите мониторинг. При запуске можно получить уже найденные объявления или только новые.",
    "",
    "Канал «Жилье в Ереване от собственников»: @yerevan_rental",
    "По всем вопросам: @monkeysees",
  ].join("\n"),
  commands: Object.freeze([
    Object.freeze({ command: "start", description: "Открыть главное меню" }),
    Object.freeze({ command: "menu", description: "Открыть главное меню" }),
    Object.freeze({ command: "filters", description: "Настроить фильтры" }),
    Object.freeze({ command: "stop", description: "Остановить мониторинг" }),
    Object.freeze({ command: "cancel", description: "Отменить ввод фильтра" }),
    Object.freeze({
      command: "clear",
      description: "Снять редактируемое ограничение",
    }),
    Object.freeze({
      command: "delete_my_data",
      description: "Удалить мои данные",
    }),
  ]),
  commandScope: Object.freeze({ type: "all_private_chats" }),
});

export const TELEGRAM_METADATA_RETRY_INTERVAL_MS = 60 * 60 * 1_000;

export async function synchronizeTelegramMetadata(api, signal) {
  await api.setMyShortDescription(
    TELEGRAM_BOT_METADATA.shortDescription,
    signal,
  );
  await api.setMyDescription(TELEGRAM_BOT_METADATA.description, signal);
  await api.setMyCommands(
    TELEGRAM_BOT_METADATA.commands,
    TELEGRAM_BOT_METADATA.commandScope,
    signal,
  );
}
