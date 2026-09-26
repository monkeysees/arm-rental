use super::{Result, filters};

use serde_json::{Value, json};

use std::collections::HashMap;

fn button(text: impl Into<String>, data: impl Into<String>) -> Value {
    json!({
    "text":text.into(),"callback_data":data.into()}
    )
}

fn view(text: impl Into<String>, rows: Vec<Vec<Value>>) -> Value {
    json!({
    "text":text.into(),"replyMarkup":{
    "inline_keyboard":rows}
    }
    )
}

fn kind_names(f: &Value) -> String {
    if f["kinds"].as_array().is_some_and(|a| a.len() > 1) {
        "Квартиры и дома".into()
    } else if f["kinds"][0] == "house" {
        "Дома".into()
    } else {
        "Квартиры".into()
    }
}

pub fn menu(f: &Value, active: bool) -> Value {
    let f = filters::normalize_filters(f);

    view(
        format!(
            "Главное меню\n\nМониторинг: {}\nТип жилья: {}\nЦена (֏): {}\nКомнаты: {}\nМестоположение: {}",
            if active {
                "запущен"
            } else {
                "остановлен"
            },
            kind_names(&f),
            filters::format_range(&f["price"], ""),
            filters::format_range(&f["rooms"], ""),
            filters::format_locations(&f["locations"])
        ),
        vec![
            vec![button("Цена, ֏", "f:price"), button("Комнаты", "f:rooms")],
            vec![
                button("Тип жилья", "f:kinds"),
                button("Местоположение", "f:locations"),
            ],
            vec![button("Сбросить фильтры", "f:reset")],
            vec![if active {
                button("Остановить мониторинг", "m:stop")
            } else {
                button("Запустить мониторинг", "m:start")
            }],
        ],
    )
}

pub fn initial_menu(limit: u64) -> Value {
    view(
        format!(
            "Отправить уже найденные объявления?\n\nПеред запуском мониторинга бот может отправить подходящие объявления за последние 24 часа — не больше {limit}. Или можно начать только с новых объявлений."
        ),
        vec![
            vec![button("Да, отправить", "m:start:initial")],
            vec![button("Нет, только новые", "m:start:new")],
            vec![button("← В главное меню", "f:menu")],
        ],
    )
}

pub fn history_menu(count: usize) -> Value {
    view(
        format!(
            "Фильтры изменены.\n\nПодходящих объявлений за последние 24 часа: {count}.\nОтправить их или ждать только новые объявления?"
        ),
        vec![
            vec![button("Да, отправить", "m:history:send")],
            vec![button("Нет, только новые", "m:history:skip")],
        ],
    )
}

pub fn announcement(count: usize) -> String {
    format!("Подходящих объявлений за последние 24 часа: {count}. Отправляю…")
}

fn deletion_menu() -> Value {
    view(
        "Удалить все ваши данные?\n\nБудут удалены фильтры и история уведомлений, а мониторинг остановится.\nПри новой регистрации подписка будет создана заново, и потребуется снова выбрать, отправлять ли уже найденные объявления.",
        vec![
            vec![button("Удалить мои данные", "d:confirm")],
            vec![button("Отмена", "d:cancel")],
        ],
    )
}

fn kinds_menu(f: &Value) -> Value {
    let selected = f["kinds"].as_array().unwrap();

    let mut rows = Vec::new();

    for (kind, label) in [("apartment", "Квартиры"), ("house", "Дома")] {
        rows.push(vec![button(
            format!(
                "{} {label}",
                if selected.contains(&json!(kind)) {
                    "✅"
                } else {
                    "▫️"
                }
            ),
            format!("f:kind:{kind}"),
        )]);
    }

    rows.push(vec![button("← В главное меню", "f:menu")]);

    view(
        format!(
            "Тип жилья\n\nВыберите, какие объявления отслеживать. Можно выбрать оба типа, но не меньше одного.\nВыбрано: {}",
            kind_names(f)
        ),
        rows,
    )
}

fn locations_menu(f: &Value) -> Value {
    let regions = filters::regions();

    let selected = f["locations"].as_array().unwrap();

    let mut rows = vec![];

    for (i, r) in regions.as_array().unwrap().iter().enumerate() {
        let n = r["places"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .filter(|(j, _)| selected.contains(&json!(format!("p:{i}:{j}"))))
            .count();

        let mark = if selected.contains(&json!(format!("r:{i}"))) {
            "✅".into()
        } else if n > 0 {
            format!("• {n}")
        } else {
            "▫️".into()
        };

        rows.push(vec![button(
            format!("{mark} {}", r["name"].as_str().unwrap()),
            format!("f:region:{i}"),
        )]);
    }

    rows.push(vec![button("← В главное меню", "f:menu")]);

    view(
        format!(
            "Выбор местоположения\n\nОткройте нужный раздел. Можно выбрать его целиком или указать одно или несколько отдельных мест.\nВыбрано: {}",
            filters::format_locations(&f["locations"])
        ),
        rows,
    )
}

fn region_menu(f: &Value, i: usize) -> Value {
    let regions = filters::regions();

    let r = &regions[i];

    if r.is_null() {
        return locations_menu(f);
    }

    let selected = f["locations"].as_array().unwrap();

    let mark = |id: String| {
        if selected.contains(&json!(id)) {
            "✅"
        } else {
            "▫️"
        }
    };

    let mut rows = vec![vec![button(
        format!(
            "{} {}",
            mark(format!("r:{i}")),
            if i == 0 {
                "Весь Ереван"
            } else {
                "Весь регион"
            }
        ),
        format!("f:all:{i}"),
    )]];

    for (j, p) in r["places"].as_array().unwrap().iter().enumerate() {
        rows.push(vec![button(
            format!("{} {}", mark(format!("p:{i}:{j}")), p.as_str().unwrap()),
            format!("f:place:{i}:{j}"),
        )]);
    }

    rows.push(vec![button("← К списку", "f:locations")]);

    view(
        format!(
            "{}\n\n{}",
            if i == 0 {
                "Ереван и его районы"
            } else {
                r["name"].as_str().unwrap()
            },
            if i == 0 {
                "Выберите весь Ереван или один или несколько его районов."
            } else {
                "Выберите весь регион или один или несколько городов и населённых пунктов."
            }
        ),
        rows,
    )
}

pub fn authorized(config: &Value, id: i64) -> bool {
    id > 0
        && id <= 9_007_199_254_740_991
        && (config["telegramOwnerId"].as_i64() == Some(id)
            || match config["telegramAccessMode"].as_str().unwrap_or("public") {
                "public" => true,
                "allowlist" => config["telegramAllowedUserIds"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!(id))),
                _ => false,
            })
}

fn command(text: &str, name: &str) -> bool {
    let word = text.split_whitespace().next().unwrap_or("").to_lowercase();

    let mut parts = word.split('@');

    parts.next() == Some(&format!("/{name}"))
        && parts.next().is_none_or(|s| {
            !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
        && parts.next().is_none()
        && !text.starts_with(char::is_whitespace)
}

fn default_user(id: i64) -> Value {
    json!({
    "chatId":id,"active":false,"sendInitialApartments":true,"filters":filters::normalize_filters(&Value::Null),"pendingFilterInput":null}
    )
}

fn send(ops: &mut Vec<Value>, id: i64, text: impl Into<String>) {
    ops.push(json!({
    "method":"sendMessage","payload":{
    "chat_id":id,"text":text.into()}
    }
    ));
}

fn show(ops: &mut Vec<Value>, id: i64, message_id: &Value, v: Value) {
    let mut payload = json!({
    "chat_id":id,"text":v["text"],"reply_markup":v["replyMarkup"]}
    );

    let method = if message_id.as_i64().is_some_and(|v| v != 0) {
        payload["message_id"] = message_id.clone();

        "editMessageText"
    } else {
        "sendMessage"
    };

    ops.push(json!({
    "method":method,"payload":payload}
    ));
}

fn answer(ops: &mut Vec<Value>, query: &Value) {
    if !query.is_null() {
        ops.push(json!({
        "method":"answerCallbackQuery","payload":{
        "callback_query_id":query["id"]}
        }
        ));
    }
}

#[derive(Default)]
pub struct Context {
    buckets: HashMap<i64, (f64, i64)>,
    gates: HashMap<(i64, String), i64>,
    confirmations: HashMap<i64, i64>,
    decisions: HashMap<(i64, i64), (bool, i64)>,
}

impl Context {
    fn gate(&mut self, id: i64, key: &str, now: i64) -> bool {
        self.gates.retain(|_, t| now - *t < 300_000);

        let k = (id, key.into());

        if let std::collections::hash_map::Entry::Vacant(entry) = self.gates.entry(k) {
            entry.insert(now);

            true
        } else {
            false
        }
    }

    fn consume(&mut self, id: i64, update: &Value, rate: f64, now: i64) -> bool {
        self.buckets.retain(|_, (_, t)| now - *t < 900_000);

        self.decisions.retain(|_, (_, t)| now - *t < 900_000);

        let key = (id, update.as_i64().unwrap_or(-1));

        if key.1 >= 0
            && let Some((v, _)) = self.decisions.get(&key)
        {
            return *v;
        }

        let (tokens, time) = self.buckets.entry(id).or_insert((rate, now));

        *tokens = rate.min(*tokens + (now - *time).max(0) as f64 * rate / 60_000.);

        *time = now;

        let yes = *tokens >= 1.;

        if yes {
            *tokens -= 1.;
        }

        if key.1 >= 0 {
            self.decisions.insert(key, (yes, now));
        }

        yes
    }

    pub fn clear(&mut self, id: i64) {
        self.buckets.remove(&id);

        self.decisions.retain(|(who, _), _| *who != id);

        self.confirmations.remove(&id);
    }
}

/// Effects requiring database work are consumed before Telegram operations by the caller.
pub struct Outcome {
    pub state: Value,
    pub operations: Vec<Value>,
    pub selection: Option<i64>,
    pub history: Option<(i64, bool)>,
    pub offer: Option<i64>,
    pub deletion: Option<i64>,
    pub offset_after_response: bool,
}

pub fn process(
    context: &mut Context,
    config: &Value,
    state: &Value,
    update: &Value,
    now: i64,
) -> Result<Outcome> {
    let mut out = Outcome {
        state: state.clone(),
        operations: vec![],
        selection: None,
        history: None,
        offer: None,
        deletion: None,
        offset_after_response: false,
    };

    let previous = state["updateOffset"].as_i64().unwrap_or(0);

    out.state["updateOffset"] = json!(
        previous.max(
            update["update_id"]
                .as_i64()
                .filter(|v| v.abs() <= 9_007_199_254_740_991)
                .map(|v| v + 1)
                .unwrap_or(previous)
        )
    );

    let q = &update["callback_query"];

    let m = if q.is_null() {
        &update["message"]
    } else {
        &q["message"]
    };

    let id = if q.is_null() {
        m["from"]["id"].as_i64()
    } else {
        q["from"]["id"].as_i64()
    };

    if m["chat"]["type"] != "private"
        || id.is_none_or(|v| v <= 0 || v > 9_007_199_254_740_991)
        || id != m["chat"]["id"].as_i64()
    {
        answer(&mut out.operations, q);

        return Ok(out);
    }

    let id = id.unwrap();

    let key = id.to_string();

    let data = q["data"].as_str().unwrap_or("");

    let text = m["text"].as_str().unwrap_or("");

    let deletion = if data == "d:confirm" {
        "confirm"
    } else if data == "d:cancel" {
        "cancel"
    } else if q.is_null() && command(text, "delete_my_data") {
        "request"
    } else {
        ""
    };

    let exists = out.state["users"].get(&key).is_some();

    let bypass = exists && !deletion.is_empty();

    if !bypass && !authorized(config, id) {
        answer(&mut out.operations, q);

        if q.is_null()
            && (command(text, "start") || command(text, "menu"))
            && context.gate(id, "denied", now)
        {
            send(
                &mut out.operations,
                id,
                format!("Доступ к боту ограничен. Ваш Telegram ID: {id}."),
            );
        }

        return Ok(out);
    }

    if !bypass
        && !context.consume(
            id,
            &update["update_id"],
            config["telegramUserUpdatesPerMinute"]
                .as_f64()
                .unwrap_or(30.),
            now,
        )
    {
        answer(&mut out.operations, q);

        if context.gate(id, "limited", now) {
            send(
                &mut out.operations,
                id,
                "Слишком много запросов. Пожалуйста, попробуйте ещё раз позже.",
            );
        }

        return Ok(out);
    }

    if !deletion.is_empty() && !exists {
        answer(&mut out.operations, q);

        if context.gate(id, "delete", now) {
            send(
                &mut out.operations,
                id,
                "У бота нет сохранённых данных для удаления.",
            );
        }

        return Ok(out);
    }

    let mut user = out.state["users"]
        .get(&key)
        .cloned()
        .unwrap_or_else(|| default_user(id));

    user["filters"] = filters::normalize_filters(&user["filters"]);

    if user.get("deletionPendingAt").is_some() {
        answer(&mut out.operations, q);

        return Ok(out);
    }

    context.confirmations.retain(|_, t| now - *t < 300_000);

    if deletion == "request" {
        if context.gate(id, "delete", now) {
            show(&mut out.operations, id, &Value::Null, deletion_menu());

            context.confirmations.insert(id, now);
        }

        return Ok(out);
    }

    if deletion == "cancel" {
        answer(&mut out.operations, q);

        if context.confirmations.remove(&id).is_some() {
            out.operations.push(json!({
            "method":"editMessageText","payload":{
            "chat_id":id,"message_id":m["message_id"],"text":"Удаление данных отменено."}
            }
            ));
        }

        return Ok(out);
    }

    if deletion == "confirm" {
        answer(&mut out.operations, q);

        if context.confirmations.remove(&id).is_some() {
            user["active"] = json!(false);

            user["pendingFilterInput"] = Value::Null;

            user["deletionPendingAt"] = json!(
                chrono::DateTime::from_timestamp_millis(now)
                    .ok_or("invalid deletion time")?
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            );

            out.state["users"][&key] = user;

            out.deletion = Some(id);
        }

        return Ok(out);
    }

    let mut changed = false;

    if !q.is_null() {
        if data == "m:start" {
            user["pendingFilterInput"] = Value::Null;

            changed = true;

            answer(&mut out.operations, q);

            show(
                &mut out.operations,
                id,
                &m["message_id"],
                initial_menu(config["initialDeliveryLimit"].as_u64().unwrap_or(100)),
            );
        } else if ["m:start:initial", "m:start:new", "m:stop"].contains(&data) {
            let active = data != "m:stop";

            user["active"] = json!(active);

            if active {
                user["sendInitialApartments"] = json!(data == "m:start:initial");

                out.selection = Some(id);
            }

            user["pendingFilterInput"] = Value::Null;

            changed = true;

            answer(&mut out.operations, q);

            show(
                &mut out.operations,
                id,
                &m["message_id"],
                menu(&user["filters"], active),
            );
        } else if data == "m:history:send" || data == "m:history:skip" {
            out.history = Some((id, data == "m:history:send"));

            answer(&mut out.operations, q);

            show(
                &mut out.operations,
                id,
                &m["message_id"],
                view(
                    if data == "m:history:send" {
                        "Отправлять нечего: подходящих объявлений за это время не осталось."
                    } else {
                        "Хорошо, эти объявления отправлены не будут — придут только новые."
                    },
                    vec![],
                ),
            );
        } else if data.starts_with("f:") {
            user["pendingFilterInput"] = Value::Null;

            changed = true;

            let parts: Vec<_> = data.split(':').collect();

            let action = parts.get(1).copied().unwrap_or("");

            let active = user["active"].as_bool().unwrap_or(false);

            let f = &mut user["filters"];

            let mut v = None;

            match action {
                "price" | "rooms" => {
                    user["pendingFilterInput"] = json!(action);

                    let (instruction, examples) = if action == "price" {
                        (
                            "Введите точную цену или диапазон в армянских драмах.",
                            "«100000-250000», «100000-» (от 100 000), «-250000» (до 250 000)",
                        )
                    } else {
                        (
                            "Введите точное количество комнат или диапазон.",
                            "«1-3», «2-» (от 2), «-4» (до 4)",
                        )
                    };

                    send(
                        &mut out.operations,
                        id,
                        format!(
                            "{instruction}\nПримеры: {examples}.\nЧтобы снять это ограничение, отправьте «нет» или /clear.\nЧтобы отменить ввод и сохранить текущее значение фильтра, отправьте /cancel."
                        ),
                    );
                }

                "menu" => {
                    v = Some(menu(f, active));

                    out.offer = Some(id);
                }

                "reset" => {
                    *f = filters::normalize_filters(&Value::Null);

                    v = Some(menu(f, active));

                    out.offer = Some(id);
                }

                "locations" => v = Some(locations_menu(f)),
                "kinds" => v = Some(kinds_menu(f)),
                "kind" => {
                    if let Some(kind) = parts.get(2).filter(|s| ["apartment", "house"].contains(s))
                    {
                        let a = f["kinds"].as_array_mut().unwrap();

                        if a.contains(&json!(kind)) {
                            if a.len() > 1 {
                                a.retain(|k| k != kind);
                            }
                        } else {
                            a.push(json!(kind));
                        }

                        *f = filters::normalize_filters(f);
                    }

                    v = Some(kinds_menu(f));
                }

                "region" | "all" | "place" => {
                    if let Some(i) = parts
                        .get(2)
                        .and_then(|s| s.parse::<usize>().ok())
                        .filter(|i| *i < filters::regions().as_array().unwrap().len())
                    {
                        let rid = json!(format!("r:{i}"));

                        if action == "all" {
                            let a = f["locations"].as_array_mut().unwrap();

                            if a.contains(&rid) {
                                a.retain(|x| x != &rid);
                            } else {
                                a.retain(|x| {
                                    !x.as_str().unwrap_or("").starts_with(&format!("p:{i}:"))
                                });

                                a.push(rid.clone());
                            }
                        }

                        if action == "place" {
                            if let Some(j) = parts
                                .get(3)
                                .and_then(|s| s.parse::<usize>().ok())
                                .filter(|j| {
                                    *j < filters::regions()[i]["places"].as_array().unwrap().len()
                                })
                            {
                                let pid = json!(format!("p:{i}:{j}"));

                                let a = f["locations"].as_array_mut().unwrap();

                                a.retain(|x| x != &rid);

                                if a.contains(&pid) {
                                    a.retain(|x| x != &pid);
                                } else {
                                    a.push(pid);
                                }
                            } else {
                                out.state["users"][&key] = user;

                                answer(&mut out.operations, q);

                                return Ok(out);
                            }
                        }

                        v = Some(region_menu(f, i));
                    }
                }

                _ => {}
            }

            if let Some(v) = v {
                show(&mut out.operations, id, &m["message_id"], v)
            }

            answer(&mut out.operations, q);
        } else {
            answer(&mut out.operations, q);
        }
    } else if ["start", "menu", "filters", "cancel", "stop"]
        .iter()
        .any(|c| command(text, c))
    {
        user["pendingFilterInput"] = Value::Null;

        if command(text, "stop") {
            user["active"] = json!(false)
        } else {
            out.offer = Some(id)
        }

        changed = true;

        show(
            &mut out.operations,
            id,
            &Value::Null,
            menu(&user["filters"], user["active"].as_bool().unwrap_or(false)),
        );
    } else if let Some(kind) = user["pendingFilterInput"]
        .as_str()
        .map(str::to_owned)
        .filter(|_| !text.is_empty())
    {
        match filters::parse_range(
            if command(text, "clear") {
                "нет"
            } else {
                text
            },
            &kind,
        ) {
            Ok(range) => {
                user["filters"][&kind] = range;

                user["pendingFilterInput"] = Value::Null;

                changed = true;

                out.offer = Some(id);

                show(
                    &mut out.operations,
                    id,
                    &Value::Null,
                    menu(&user["filters"], user["active"].as_bool().unwrap_or(false)),
                );
            }

            Err(e) => {
                out.offset_after_response = true;

                send(
                    &mut out.operations,
                    id,
                    format!(
                        "{e}\nПопробуйте ещё раз, отправьте /clear, чтобы снять это ограничение, или /cancel, чтобы отменить ввод и сохранить текущее значение фильтра."
                    ),
                );
            }
        }
    }

    if changed {
        out.state["users"][&key] = user;
    }

    Ok(out)
}

#[derive(Default)]
pub struct Bot {
    context: Context,
    history_failure: Option<String>,
}

impl Bot {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn handle_update(
        &mut self,
        db: &mut super::storage::Database,
        config: &super::config::Config,
        update: &Value,
        now: i64,
    ) -> Result<Vec<Value>> {
        let state = db.load_telegram()?;

        let mut out = process(&mut self.context, &config.values, &state, update, now)?;

        if out.offset_after_response {
            let offset = out.state["updateOffset"].clone();

            out.state["updateOffset"] = state["updateOffset"].clone();

            if let Some(op) = out.operations.last_mut() {
                op["ackOffset"] = offset;
            }
        }

        let history_answer = if let Some((id, accepted)) = out.history {
            let ids = history_ids(
                db,
                id,
                &out.state["users"][id.to_string()]["filters"],
                now,
                config.values["initialDeliveryLimit"]
                    .as_u64()
                    .unwrap_or(100) as usize,
            )?;
            if out.state["users"] != state["users"] {
                return Err("History answers cannot change Telegram users".into());
            }
            let offset = out.state["updateOffset"].as_i64().ok_or("Invalid update offset")?;
            let recipient = id.to_string();
            let failure = self.history_failure.as_deref();
            db.transaction_named("telegram_history_answer", |c| {
                c.execute(
                    "UPDATE telegram_state SET update_offset=? WHERE singleton=1",
                    [offset],
                )?;
                for item in &ids {
                    if failure == Some("decision_write") {
                        c.execute(
                            "UPDATE private_delivery_decisions SET status=99 WHERE recipient_id=? AND item_id=?",
                            rusqlite::params![recipient, item],
                        )?;
                    }
                    if accepted {
                        c.execute(
                            "DELETE FROM private_delivery_decisions WHERE recipient_id=? AND item_id=? AND status=2",
                            rusqlite::params![recipient, item],
                        )?;
                        c.execute(
                            "INSERT OR IGNORE INTO private_delivery_work(recipient_id,item_id) VALUES(?,?)",
                            rusqlite::params![recipient, item],
                        )?;
                    } else {
                        c.execute(
                            "UPDATE private_delivery_decisions SET status=1,decided_at=? WHERE recipient_id=? AND item_id=? AND status=2",
                            rusqlite::params![now, recipient, item],
                        )?;
                    }
                }
                if failure == Some("before_commit") {
                    c.execute(
                        "UPDATE telegram_state SET update_offset=-1 WHERE singleton=1",
                        [],
                    )?;
                }
                Ok(())
            })?;
            Some((ids, accepted))
        } else {
            db.save_telegram(&out.state)?;
            None
        };
        let saved_offset = out.state["updateOffset"].as_i64().unwrap_or(0);
        self.context
            .decisions
            .retain(|(_, id), _| *id >= saved_offset);

        if let Some(id) = out.selection {
            db.request_selection(&id.to_string())?;
        }

        if let Some((ids, accepted)) = history_answer {
            if accepted
                && !ids.is_empty()
                && let Some(op) = out
                    .operations
                    .iter_mut()
                    .find(|op| op["method"] != "answerCallbackQuery")
            {
                op["payload"]["text"] = json!(format!(
                    "Хорошо, отправлю их при следующей проверке. Объявлений: {}.",
                    ids.len()
                ));
            }
        }

        if let Some(id) = out.offer {
            let ids = history_ids(
                db,
                id,
                &out.state["users"][id.to_string()]["filters"],
                now,
                config.values["initialDeliveryLimit"]
                    .as_u64()
                    .unwrap_or(100) as usize,
            )?;

            if !ids.is_empty() {
                let mut extra = vec![];

                show(&mut extra, id, &Value::Null, history_menu(ids.len()));

                let at = out
                    .operations
                    .iter()
                    .position(|op| op["method"] == "answerCallbackQuery")
                    .unwrap_or(out.operations.len());

                out.operations.splice(at..at, extra);
            }
        }

        if let Some(id) = out.deletion {
            for op in &mut out.operations {
                if op["method"] == "answerCallbackQuery" {
                    op["ignoreError"] = json!(true);
                }
            }

            out.operations.push(json!({
            "method":"deleteUserData","recipientId":id}
            ));
        }

        Ok(out.operations)
    }

    pub fn complete_deletion(&mut self, db: &super::storage::Database, id: i64) -> Result<Value> {
        db.delete_user_data(id)?;
        self.context.clear(id);

        Ok(json!({
        "method":"sendMessage","payload":{
        "chat_id":id,"text":"Ваши данные удалены."}
        }
        ))
    }
}

pub fn recent(apartment: &Value, now: i64) -> bool {
    let within = |key: &str| {
        apartment[key]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|v| now - v.timestamp_millis() < 86_400_000)
    };

    apartment["date"]
        .as_str()
        .and_then(|s| super::source::posting_date_ms(s, now))
        .map(|posted| now - posted < 86_400_000)
        .unwrap_or_else(|| within("firstSeenAt"))
        || within("updatedAt")
}

fn history_ids(
    db: &super::storage::Database,
    id: i64,
    filter: &Value,
    now: i64,
    limit: usize,
) -> Result<Vec<String>> {
    let mut stmt=db.connection.prepare("SELECT a.item_id,a.payload_json,a.last_seen_at FROM apartments a JOIN private_delivery_decisions d USING(item_id) JOIN telegram_users u ON CAST(u.chat_id AS TEXT)=d.recipient_id WHERE u.active=1 AND u.deletion_pending_at IS NULL AND d.recipient_id=? AND d.status=2 ORDER BY a.encounter_sequence DESC,a.encounter_position ASC")?;

    let mut rows = stmt.query([id.to_string()])?;

    let mut ids = vec![];

    while let Some(row) = rows.next()? {
        let mut a: Value = serde_json::from_str(&row.get::<_, String>(1)?)?;

        a["lastSeenAt"] = json!(row.get::<_, Option<String>>(2)?);

        if filters::matches(&a, filter) && recent(&a, now) {
            ids.push(row.get(0)?);

            if ids.len() >= limit {
                break;
            }
        }
    }

    Ok(ids)
}

pub fn metadata_operations() -> Vec<Value> {
    vec![
        json!({
        "method":"setMyShortDescription","payload":{
        "short_description":"Квартиры и дома с List.am.\nКанал «Жилье в Ереване от собственников»: @yerevan_rental.\nСвязь: @monkeysees."}
        }
        ),
        json!({
        "method":"setMyDescription","payload":{
        "description":"Бот находит на List.am объявления о долгосрочной аренде квартир и домов от собственников и присылает новые подходящие варианты.\n\nНастройте тип жилья, цену в драмах, количество комнат и местоположение, затем запустите мониторинг. При запуске можно получить уже найденные объявления или только новые.\n\nКанал «Жилье в Ереване от собственников»: @yerevan_rental\nПо всем вопросам: @monkeysees"}
        }
        ),
        json!({
        "method":"setMyCommands","payload":{
        "scope":{
        "type":"all_private_chats"}
        ,"commands":[{
        "command":"start","description":"Открыть главное меню"}
        ,{
        "command":"menu","description":"Открыть главное меню"}
        ,{
        "command":"filters","description":"Настроить фильтры"}
        ,{
        "command":"stop","description":"Остановить мониторинг"}
        ,{
        "command":"cancel","description":"Отменить ввод фильтра"}
        ,{
        "command":"clear","description":"Снять редактируемое ограничение"}
        ,{
        "command":"delete_my_data","description":"Удалить мои данные"}
        ]}
        }
        ),
    ]
}

/// Public differential protocol: process a sequence using the same live handler policy.
pub fn contract(v: Value) -> Result<Value> {
    if let Some(directory) = v["directory"].as_str() {
        let mut db = super::storage::Database::open(
            std::path::Path::new(directory),
            v["config"]["telegramChannelId"].as_str(),
        )?;

        let config = super::config::Config {
            values: v["config"].clone(),
        };

        let mut bot = Bot {
            history_failure: v["failHistoryAt"].as_str().map(str::to_owned),
            ..Bot::default()
        };
        let mut operations = vec![];
        let mut deletions = vec![];

        for update in v["updates"].as_array().ok_or("updates must be an array")? {
            for op in bot.handle_update(
                &mut db,
                &config,
                update,
                v["nowMs"].as_i64().unwrap_or(1_700_000_000_000),
            )? {
                if op["method"] == "deleteUserData" {
                    deletions.push(op["recipientId"].as_i64().unwrap());
                } else {
                    operations.push(op);
                }
            }
        }

        for id in deletions {
            operations.push(bot.complete_deletion(&db, id)?);
        }

        return Ok(json!({
        "state":db.load_telegram()?,"operations":operations}
        ));
    }

    let mut context = Context::default();

    let mut state = v.get("state").cloned().unwrap_or(json!({
    "version":3,"type":"telegram-bot","updateOffset":0,"users":{
    }
    }
    ));

    let mut operations = vec![];

    let mut outcomes = vec![];

    for update in v["updates"].as_array().ok_or("updates must be an array")? {
        let result = process(
            &mut context,
            &v["config"],
            &state,
            update,
            v["nowMs"].as_i64().unwrap_or(1_700_000_000_000),
        )?;

        state = result.state;

        operations.extend(result.operations);

        outcomes.push(json!({
"selection":result.selection,"history":result.history,"offer":result.offer,"deletion":result.deletion}
));
    }

    Ok(json!({
    "state":state,"operations":operations,"outcomes":outcomes}
    ))
}
