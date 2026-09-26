use super::Result;
use chrono::{DateTime, Datelike, NaiveDate, Timelike, Utc};
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

fn re(s: &'static str) -> Regex {
    static EXPRESSIONS: LazyLock<Mutex<HashMap<&'static str, Regex>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    EXPRESSIONS
        .lock()
        .expect("regex cache")
        .entry(s)
        .or_insert_with(|| Regex::new(s).expect("static expression"))
        .clone()
}
fn text(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn number(s: &str) -> Value {
    let clean: String = s
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
        .collect();
    let digits: String = clean.chars().filter(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return Value::Null;
    }
    let decimal = re(r"[.,](\d{1,2})$")
        .captures(&clean)
        .map(|c| c[1].len())
        .unwrap_or(0);
    let n = digits.parse::<f64>().unwrap_or(f64::NAN) / 10f64.powi(decimal as i32);
    if n.fract() == 0.0 && n >= 0.0 && n < u64::MAX as f64 {
        json!(n as u64)
    } else {
        json!(n)
    }
}
pub fn parse_price(s: &str) -> Value {
    let s = text(s);
    let amount = re(r"[0-9][0-9\s.,]*")
        .find(&s)
        .map(|m| number(m.as_str()))
        .unwrap_or(Value::Null);
    let currency = ["֏", "$", "€", "₽", "£", "AMD", "USD", "EUR", "RUB", "GBP"]
        .into_iter()
        .find(|c| s.contains(c));
    json!({"amount":amount,"currency":currency})
}
fn details(s: &str) -> Value {
    let s = text(s);
    let rooms = re(r"(?i)([0-9]+)\s*(?:ком|room)")
        .captures(&s)
        .map(|c| number(&c[1]));
    let area = re(r"(?i)([0-9.,]+)\s*(?:кв|sq)")
        .captures(&s)
        .map(|c| number(&c[1]));
    let floor = re(r"([0-9]+)\s*/\s*([0-9]+)")
        .captures(&s)
        .map(|c| format!("{}/{}", &c[1], &c[2]));
    let leading = s.split([',', '·']).next().unwrap_or("").trim();
    let attribute =
        re(r"(?i)([0-9]+)\s*(?:ком|room)|([0-9.,]+)\s*(?:кв|sq)|([0-9]+)\s*/\s*([0-9]+)")
            .is_match(leading);
    json!({"location":if attribute {""} else {leading},"rooms":rooms,"areaSqM":area,"floor":floor})
}
fn field(card: ElementRef<'_>, selector: &str) -> String {
    card.select(&Selector::parse(selector).expect("static selector"))
        .next()
        .map(|n| text(&n.text().collect::<String>()))
        .unwrap_or_default()
}
fn item_id(href: &str) -> Option<String> {
    if href.trim().is_empty() {
        return None;
    }
    let base = url::Url::parse("https://www.list.am").ok()?;
    let url = base.join(href.trim()).ok()?;
    if url.origin() != base.origin() {
        return None;
    }
    re(r"^/(?:[a-z]{2}/)?item/([0-9]+)/?$")
        .captures(url.path())
        .map(|c| c[1].to_owned())
}
pub fn parse_page(html: &str, _kind: &str, reference_ms: i64) -> Result<Value> {
    let doc = Html::parse_document(html);
    let section_selector = Selector::parse("#contentr").unwrap();
    let section = doc
        .select(&section_selector)
        .next()
        .ok_or("ERR_LIST_AM_REGULAR_SECTION_MISSING")?;
    let mut apartments = Vec::new();
    let mut ids = HashSet::new();
    let (mut candidates, mut duplicates, mut rejected) = (0, 0, 0);
    let selector =
        Selector::parse("a.category-data-list-card__destination, a.fav-item-info-container")
            .unwrap();
    let mut completeness =
        json!({"title":0,"date":0,"price":0,"location":0,"rooms":0,"areaSqM":0,"floor":0});
    for card in section.select(&selector) {
        if card
            .ancestors()
            .filter_map(ElementRef::wrap)
            .any(|e| e.value().id() == Some("tp"))
        {
            continue;
        }
        candidates += 1;
        let Some(id) = card.value().attr("href").and_then(item_id) else {
            rejected += 1;
            continue;
        };
        if !ids.insert(id.clone()) {
            duplicates += 1;
            continue;
        }
        let mut a = details(&field(card, ".at"));
        a["url"] = json!(format!("https://www.list.am/ru/item/{id}"));
        a["itemId"] = json!(id);
        a["title"] = json!(field(card, ".dltitle .pt, .dltitle, .pt"));
        a["price"] = parse_price(&field(card, ".p"));
        let location = field(card, ".l");
        if !location.is_empty() {
            a["location"] = json!(location);
        }
        let date = field(card, ".d");
        a["date"] = if date.is_empty() {
            Value::Null
        } else {
            json!(date)
        };
        for key in [
            "title", "date", "price", "location", "rooms", "areaSqM", "floor",
        ] {
            let valid = match key {
                "date" => a[key]
                    .as_str()
                    .and_then(|s| posting_date_ms(s, reference_ms))
                    .is_some(),
                "price" => a[key]["amount"].is_number() && !a[key]["currency"].is_null(),
                "rooms" | "areaSqM" => a[key].is_number(),
                _ => a[key].as_str().is_some_and(|s| !s.is_empty()),
            };
            if valid {
                completeness[key] = json!(completeness[key].as_u64().unwrap() + 1);
            }
        }
        apartments.push(a);
    }
    Ok(
        json!({"candidateCount":candidates,"uniqueCandidateCount":ids.len(),"parsedCount":apartments.len(),"duplicateCount":duplicates,"rejectedCount":rejected,"apartments":apartments,"completeness":completeness}),
    )
}
fn month(s: &str) -> Option<u32> {
    let names = [
        "январь января january",
        "февраль февраля february",
        "март марта march",
        "апрель апреля april",
        "май мая mай may",
        "июнь июня june",
        "июль июля july",
        "август августа august",
        "сентябрь сентября september",
        "октябрь октября october",
        "ноябрь ноября november",
        "декабрь декабря december",
    ];
    names
        .iter()
        .position(|names| names.split_whitespace().any(|n| n == s.to_lowercase()))
        .map(|m| m as u32 + 1)
}
fn eod(year: i32, month: u32, day: u32) -> Option<i64> {
    Some(
        NaiveDate::from_ymd_opt(year, month, day)?
            .and_hms_milli_opt(23, 59, 59, 999)?
            .and_utc()
            .timestamp_millis(),
    )
}
pub fn posting_date_ms(s: &str, reference_ms: i64) -> Option<i64> {
    let s = s.trim();
    if let Some(c) =
        re(r"^[^,]+,\s*([^,\s]+)\s+([0-9]{1,2}),\s*([0-9]{4}),\s*([0-9]{1,2}):([0-9]{2})$")
            .captures(s)
    {
        let year: i32 = c[3].parse().ok()?;
        if year < 100 {
            return None;
        }
        return Some(
            NaiveDate::from_ymd_opt(year, month(&c[1])?, c[2].parse().ok()?)?
                .and_hms_opt(c[4].parse().ok()?, c[5].parse().ok()?, 0)?
                .and_utc()
                .timestamp_millis(),
        );
    }
    if let Some(c) = re(r"^([^\s,]+)\s*,\s*([0-9]{1,2}):([0-9]{2})$").captures(s) {
        let days = match c[1].to_lowercase().as_str() {
            "сегодня" | "today" => 0,
            "вчера" | "yesterday" => 1,
            _ => return None,
        };
        if c[2].parse::<u32>().ok()? > 23 || c[3].parse::<u32>().ok()? > 59 {
            return None;
        }
        let d = DateTime::<Utc>::from_timestamp_millis(reference_ms - days * 86_400_000)?;
        return eod(d.year(), d.month(), d.day());
    }
    let c = re(r"^([^\s,]+)\s+([0-9]{1,2})$").captures(s)?;
    let m = month(&c[1])?;
    let day = c[2].parse().ok()?;
    let mut year = DateTime::<Utc>::from_timestamp_millis(reference_ms)?.year();
    if eod(year, m, day).is_some_and(|v| v - reference_ms > 172_800_000) {
        year -= 1;
    }
    eod(year, m, day)
}
pub fn format_posting_date(ms: i64) -> Option<String> {
    let d = DateTime::<Utc>::from_timestamp_millis(ms)?;
    let weekdays = [
        "Воскресенье",
        "Понедельник",
        "Вторник",
        "Среда",
        "Четверг",
        "Пятница",
        "Суббота",
    ];
    let months = [
        "Январь",
        "Февраль",
        "Март",
        "Апрель",
        "Май",
        "Июнь",
        "Июль",
        "Август",
        "Сентябрь",
        "Октябрь",
        "Ноябрь",
        "Декабрь",
    ];
    Some(format!(
        "{}, {} {:02}, {}, {:02}:{:02}",
        weekdays[d.weekday().num_days_from_sunday() as usize],
        months[d.month0() as usize],
        d.day(),
        d.year(),
        d.hour(),
        d.minute()
    ))
}
pub fn currency_code(s: &str) -> Option<&'static str> {
    match s.trim().to_uppercase().as_str() {
        "֏" | "AMD" => Some("AMD"),
        "$" | "USD" => Some("USD"),
        "€" | "EUR" => Some("EUR"),
        "₽" | "RUB" => Some("RUB"),
        "£" | "GBP" => Some("GBP"),
        _ => None,
    }
}
pub fn normalize_price(price: &Value, rates: &Value) -> Result<Value> {
    if price.get("amountAmd").is_some() {
        return Ok(price.clone());
    }
    let amount = price["amount"].as_f64().filter(|v| *v >= 0.0);
    let currency = price["currency"].as_str().and_then(currency_code);
    let mut out = json!({"amountAmd":null,"originalAmount":amount,"originalCurrency":currency,"exchangeRate":null,"exchangeRateFetchedAt":null,"exchangeRateEffectiveDate":null});
    if let (Some(amount), Some(currency)) = (amount, currency) {
        if currency == "AMD" {
            out["amountAmd"] = json!(amount.round());
        } else {
            let quote = &rates["rates"][currency];
            let rate = quote["rate"]
                .as_f64()
                .filter(|v| *v > 0.0)
                .ok_or("Missing valid persisted CBA rate")?;
            let units = quote["amount"]
                .as_f64()
                .filter(|v| *v > 0.0)
                .ok_or("Missing valid persisted CBA amount")?;
            let unit = rate / units;
            out["amountAmd"] = json!((amount * unit).round());
            out["exchangeRate"] = json!(unit);
            out["exchangeRateFetchedAt"] = rates["fetchedAt"].clone();
            out["exchangeRateEffectiveDate"] = rates["effectiveDate"].clone();
        }
    }
    Ok(out)
}
pub fn amd_amount(price: &Value) -> Option<f64> {
    price["amountAmd"].as_f64().or_else(|| {
        if price["currency"].as_str().and_then(currency_code) == Some("AMD") {
            price["amount"].as_f64()
        } else {
            None
        }
    })
}
pub fn contract(v: Value) -> Result<Value> {
    let reference = v["referenceMs"].as_i64().unwrap_or(0);
    match v["op"].as_str().unwrap_or("") {
        "parse" => parse_page(
            v["html"].as_str().unwrap_or(""),
            v["kind"].as_str().unwrap_or("apartment"),
            reference,
        ),
        "date" => Ok(match v["action"].as_str() {
            Some("index") => posting_date_index(v["value"].as_str().unwrap_or(""), reference),
            Some("format") => json!(format_posting_date(reference)),
            _ => json!(posting_date_ms(
                v["value"].as_str().unwrap_or(""),
                reference
            )),
        }),
        "price" => {
            if v.get("price").is_some() {
                normalize_price(&v["price"], &v["rates"])
            } else {
                Ok(parse_price(v["value"].as_str().unwrap_or("")))
            }
        }
        "filters" | "format" => super::filters::contract(v),
        "rates" => parse_rates(
            v["xml"].as_str().unwrap_or(""),
            v["fetchedAt"].as_str().unwrap_or(""),
        ),
        "integrity" => evaluate_integrity(
            &v["diagnostics"],
            v["page"].as_u64().unwrap_or(1),
            &v["priorFirstPageCounts"],
        ),
        _ => Err("Unknown domain contract operation".into()),
    }
}
pub fn evaluate_integrity(d: &Value, page: u64, prior: &Value) -> Result<Value> {
    let n = |k: &str| d[k].as_u64().unwrap_or(0);
    let reason = if page == 1 && n("candidateCount") == 0 {
        Some("FIRST_PAGE_EMPTY")
    } else if n("uniqueCandidateCount") > n("parsedCount") {
        Some("PARSE_SUCCESS_BELOW_THRESHOLD")
    } else if n("rejectedCount") > 0 {
        Some("IDENTITY_REJECTION")
    } else if page == 1 && d["completeness"]["title"].as_u64().unwrap_or(0) < n("parsedCount") {
        Some("TITLE_COMPLETENESS_BELOW_THRESHOLD")
    } else {
        None
    };
    if let Some(reason) = reason {
        return Err(Box::new(IntegrityError::new(reason, d, page, "", None)));
    }
    let mut counts: Vec<u64> = prior
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_u64).collect())
        .unwrap_or_default();
    if page == 1 && counts.len() >= 3 {
        counts.sort_unstable();
        let m = counts.len() / 2;
        let twice = if counts.len() % 2 == 1 {
            2u128 * counts[m] as u128
        } else {
            counts[m - 1] as u128 + counts[m] as u128
        };
        let current = n("parsedCount") as u128;
        if 4 * current < twice && twice - 2 * current >= 10 {
            return Err(Box::new(IntegrityError::new(
                "FIRST_PAGE_COUNT_DROP",
                d,
                page,
                "",
                Some((counts.len(), twice)),
            )));
        }
    }
    Ok(d.clone())
}
pub fn parse_rates(xml: &str, fetched_at: &str) -> Result<Value> {
    let doc = roxmltree::Document::parse(xml)?;
    let result = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "ExchangeRatesLatestResult")
        .ok_or("CBA exchange-rate response did not contain a result")?;
    let field = |node: roxmltree::Node<'_, '_>, name: &str| -> String {
        node.descendants()
            .skip(1)
            .find(|n| n.is_element() && n.tag_name().name() == name)
            .map(|n| {
                n.descendants()
                    .filter(|n| n.is_text())
                    .filter_map(|n| n.text())
                    .collect::<String>()
                    .trim()
                    .to_owned()
            })
            .unwrap_or_default()
    };
    let date = field(result, "CurrentDate");
    let date = re(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}")
        .find(&date)
        .ok_or("CBA exchange-rate response had an invalid effective date")?
        .as_str()
        .to_owned();
    let mut rates = json!({});
    for entry in result
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "ExchangeRate")
    {
        let iso = field(entry, "ISO").to_uppercase();
        if !["USD", "EUR", "RUB"].contains(&iso.as_str()) {
            continue;
        }
        let amount = field(entry, "Amount")
            .replace(',', ".")
            .parse::<f64>()
            .unwrap_or(0.0);
        let rate = field(entry, "Rate")
            .replace(',', ".")
            .parse::<f64>()
            .unwrap_or(0.0);
        rates[&iso] = json!({"amount":amount,"rate":rate});
    }
    if DateTime::parse_from_rfc3339(fetched_at).is_err()
        || ["USD", "EUR", "RUB"].iter().any(|c| {
            rates[c]["amount"].as_f64().unwrap_or(0.0) <= 0.0
                || rates[c]["rate"].as_f64().unwrap_or(0.0) <= 0.0
        })
    {
        return Err("CBA exchange-rate response was missing valid USD, EUR, or RUB rates".into());
    }
    Ok(
        json!({"version":1,"type":"cba-exchange-rates","baseCurrency":"AMD","fetchedAt":fetched_at,"effectiveDate":date,"rates":rates}),
    )
}
pub fn posting_date_index(s: &str, reference_ms: i64) -> Value {
    let s = s.trim();
    if let Some(c) = re(r"^([^\s,]+)\s+([0-9]{1,2})$").captures(s)
        && let (Some(month), Ok(day)) = (month(&c[1]), c[2].parse::<u32>())
        && eod(2000, month, day).is_some()
    {
        return json!({"bucket":"annual","key":(month-1)*32+day});
    }
    if re(r"^([^\s,]+)\s*,\s*([0-9]{1,2}):([0-9]{2})$").is_match(s)
        && posting_date_ms(s, reference_ms).is_some()
    {
        return json!({"bucket":"relative","key":if s.to_lowercase().starts_with("вчера")||s.to_lowercase().starts_with("yesterday"){-1}else{0}});
    }
    json!({"bucket":"fixed","key":posting_date_ms(s,reference_ms)})
}

pub fn parse_and_evaluate(
    html: &str,
    kind: &str,
    page: u64,
    prior: &Value,
    reference_ms: i64,
) -> Result<Value> {
    let diagnostics = parse_page(html, kind, reference_ms).map_err(|error| {
        if error.to_string() == "ERR_LIST_AM_REGULAR_SECTION_MISSING" {
            Box::<dyn std::error::Error + Send + Sync>::from(IntegrityError::new("REGULAR_SECTION_MISSING", &json!({"candidateCount":0,"uniqueCandidateCount":0,"parsedCount":0,"duplicateCount":0,"rejectedCount":0,"completeness":{"title":0,"date":0,"price":0,"location":0,"rooms":0,"areaSqM":0,"floor":0}}), page, kind, None))
        } else { error }
    })?;
    evaluate_integrity(&diagnostics, page, prior).map_err(|error| {
        if let Ok(mut integrity) = error.downcast::<IntegrityError>() {
            if !kind.is_empty() {
                integrity.details["kind"] = json!(kind);
            }
            integrity as Box<dyn std::error::Error + Send + Sync>
        } else {
            Box::<dyn std::error::Error + Send + Sync>::from("Source integrity failure")
        }
    })
}

pub fn within_activity_window(timestamp: &str, reference_ms: i64) -> bool {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .is_some_and(|t| reference_ms - t.timestamp_millis() < 86_400_000)
}
pub fn posted_within_activity(a: &Value, reference_ms: i64) -> bool {
    if let Some(posted) = a["date"]
        .as_str()
        .and_then(|s| posting_date_ms(s, reference_ms))
    {
        reference_ms - posted < 86_400_000
    } else {
        within_activity_window(a["firstSeenAt"].as_str().unwrap_or(""), reference_ms)
    }
}
pub fn within_activity(a: &Value, reference_ms: i64) -> bool {
    posted_within_activity(a, reference_ms)
        || within_activity_window(a["updatedAt"].as_str().unwrap_or(""), reference_ms)
}

#[derive(Debug)]
pub struct IntegrityError {
    pub reason: String,
    pub details: Value,
}
impl std::fmt::Display for IntegrityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "List.am source integrity check failed: {}", self.reason)
    }
}
impl std::error::Error for IntegrityError {}
impl IntegrityError {
    fn new(
        reason: &str,
        diagnostics: &Value,
        page: u64,
        kind: &str,
        prior: Option<(usize, u128)>,
    ) -> Self {
        let mut details = page_summary(diagnostics, page, kind);
        details["reason"] = json!(reason);
        match reason {
            "PARSE_SUCCESS_BELOW_THRESHOLD" => {
                details["thresholds"] = json!({"minimumParseSuccessPercent":100})
            }
            "TITLE_COMPLETENESS_BELOW_THRESHOLD" => {
                details["thresholds"] = json!({"minimumTitleCompletenessPercent":100})
            }
            "FIRST_PAGE_COUNT_DROP" => {
                details["thresholds"] =
                    json!({"minimumPriorCount":3,"countDropPercent":50,"minimumAbsoluteDrop":5})
            }
            _ => {}
        }
        if let Some((count, twice)) = prior {
            details["priorCount"] = json!(count);
            details["priorMedianTwice"] = json!(twice.to_string());
        }
        Self {
            reason: reason.into(),
            details,
        }
    }
}
pub fn page_summary(d: &Value, page: u64, kind: &str) -> Value {
    let mut result = json!({"page":page});
    if !kind.is_empty() {
        result["kind"] = json!(kind);
    }
    for key in [
        "candidateCount",
        "uniqueCandidateCount",
        "parsedCount",
        "duplicateCount",
        "rejectedCount",
        "completeness",
    ] {
        result[key] = d[key].clone();
    }
    result
}
