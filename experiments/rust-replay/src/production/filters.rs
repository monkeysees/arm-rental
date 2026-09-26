use super::{Result, source};
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;
pub fn regions() -> Value {
    serde_json::from_str(include_str!("locations.json")).expect("location catalog")
}
fn folded(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase()
}
fn valid_location(id: &str) -> bool {
    let p: Vec<_> = id.split(':').collect();
    let r = regions();
    if p.iter()
        .skip(1)
        .any(|s| s.parse::<usize>().ok().is_none_or(|n| n.to_string() != *s))
    {
        return false;
    }
    let Some(region) = p
        .get(1)
        .and_then(|s| s.parse::<usize>().ok())
        .and_then(|i| r.get(i))
    else {
        return false;
    };
    match p.first() {
        Some(&"r") => p.len() == 2,
        Some(&"p") => {
            p.len() == 3
                && p[2]
                    .parse::<usize>()
                    .ok()
                    .and_then(|i| region["places"].get(i))
                    .is_some()
        }
        _ => false,
    }
}
pub fn normalize_filters(v: &Value) -> Value {
    let kinds: Vec<_> = ["apartment", "house"]
        .into_iter()
        .filter(|k| {
            v["kinds"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == k))
        })
        .collect();
    let kinds = if kinds.is_empty() {
        vec!["apartment"]
    } else {
        kinds
    };
    let mut locations: Vec<String> = Vec::new();
    if let Some(ids) = v["locations"].as_array() {
        for id in ids.iter().filter_map(Value::as_str) {
            if valid_location(id) && !locations.iter().any(|s| s == id) {
                locations.push(id.to_owned());
            }
        }
    }
    let all = locations.clone();
    locations.retain(|id| {
        !id.starts_with("p:") || !all.contains(&format!("r:{}", id.split(':').nth(1).unwrap()))
    });
    let bound = |dimension: &str, key: &str| v[dimension][key].as_f64().filter(|v| *v >= 0.0);
    json!({"kinds":kinds,"price":{"min":bound("price","min"),"max":bound("price","max")},"rooms":{"min":bound("rooms","min"),"max":bound("rooms","max")},"locations":locations})
}
pub fn normalize(v: &Value) -> Value {
    normalize_filters(v)
}
fn names(id: &str) -> Vec<String> {
    let p: Vec<_> = id.split(':').collect();
    let r = regions();
    let Some(region) = p
        .get(1)
        .and_then(|s| s.parse::<usize>().ok())
        .and_then(|i| r.get(i))
    else {
        return vec![];
    };
    if p[0] == "r" {
        std::iter::once(region["name"].as_str().unwrap())
            .chain(
                region["places"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str),
            )
            .map(folded)
            .collect()
    } else {
        p.get(2)
            .and_then(|s| s.parse::<usize>().ok())
            .and_then(|i| region["places"].get(i))
            .and_then(Value::as_str)
            .map(|s| vec![folded(s)])
            .unwrap_or_default()
    }
}
pub fn matches(a: &Value, raw: &Value) -> bool {
    let f = normalize_filters(raw);
    let kind = match a["kind"].as_str() {
        Some("house") => "house",
        _ => "apartment",
    };
    if !f["kinds"].as_array().unwrap().iter().any(|v| v == kind) {
        return false;
    }
    for (key, value) in [
        ("price", source::amd_amount(&a["price"])),
        ("rooms", a["rooms"].as_f64()),
    ] {
        let min = f[key]["min"].as_f64();
        let max = f[key]["max"].as_f64();
        if (min.is_some() || max.is_some())
            && value.is_none_or(|v| min.is_some_and(|m| v < m) || max.is_some_and(|m| v > m))
        {
            return false;
        }
    }
    let ids = f["locations"].as_array().unwrap();
    if ids.is_empty() {
        return true;
    }
    let normalized = folded(a["location"].as_str().unwrap_or(""));
    let parts: Vec<_> = normalized
        .split([',', '/'])
        .map(|s| folded(s.trim()))
        .collect();
    ids.iter()
        .filter_map(Value::as_str)
        .flat_map(names)
        .any(|n| parts.contains(&n))
}
pub fn parse_range(value: &str, kind: &str) -> Result<Value> {
    let text = value.trim().to_lowercase();
    if ["нет", "любой", "любое", "сбросить"].contains(&text.as_str()) {
        return Ok(json!({"min":null,"max":null}));
    }
    let compact: String = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| if c == '–' || c == '—' { '-' } else { c })
        .collect();
    let label = if kind == "price" {
        "Цена"
    } else {
        "Количество комнат"
    };
    let invalid = || {
        let examples = if kind == "price" {
            "«100000-250000», «100000-» или «-250000»"
        } else {
            "«1-3», «2-» или «-4»"
        };
        format!("{label}: введите целое число или диапазон, например {examples}.")
    };
    let parts: Vec<_> = compact.split('-').collect();
    let (lo, hi) = match parts.as_slice() {
        [one] if !one.is_empty() && one.chars().all(|c| c.is_ascii_digit()) => (*one, *one),
        [lo, hi]
            if lo.chars().all(|c| c.is_ascii_digit()) && hi.chars().all(|c| c.is_ascii_digit()) =>
        {
            (*lo, *hi)
        }
        _ => return Err(invalid().into()),
    };
    if lo.is_empty() && hi.is_empty() {
        return Err(format!("{label}: укажите хотя бы одну границу диапазона.").into());
    }
    let parse = |s: &str| -> Result<Option<u64>> {
        if s.is_empty() {
            return Ok(None);
        }
        if !s.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("{label}: используйте только целые числа.").into());
        }
        let n = s
            .parse::<u64>()
            .ok()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or_else(|| format!("{label}: число слишком большое."))?;
        Ok(Some(n))
    };
    let min = parse(lo)?;
    let max = parse(hi)?;
    if kind == "rooms" && (min == Some(0) || max == Some(0)) {
        return Err("Количество комнат должно быть не меньше одного.".into());
    }
    if matches!((min,max),(Some(a),Some(b)) if a>b) {
        return Err(
            format!("{label}: минимальное значение не может быть больше максимального.").into(),
        );
    }
    Ok(json!({"min":min,"max":max}))
}
fn display(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        s.to_owned()
    } else if let Some(n) = v.as_f64() {
        n.to_string()
    } else {
        v.to_string()
    }
}
pub fn format_number(n: f64) -> String {
    let raw = format!("{:.3}", n);
    let raw = raw.trim_end_matches('0').trim_end_matches('.');
    let (whole, frac) = raw.split_once('.').unwrap_or((raw, ""));
    let mut out = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            out.push('\u{a0}');
        }
        out.push(c);
    }
    if !frac.is_empty() {
        out.push(',');
        out.push_str(frac);
    }
    out
}
pub fn format_range(r: &Value, suffix: &str) -> String {
    let min = r["min"].as_f64();
    let max = r["max"].as_f64();
    match (min, max) {
        (None, None) => "без ограничений".into(),
        (Some(a), Some(b)) if a == b => format!("{}{suffix}", format_number(a)),
        (Some(a), Some(b)) => format!("{}–{}{suffix}", format_number(a), format_number(b)),
        (Some(a), None) => format!("от {}{suffix}", format_number(a)),
        (None, Some(b)) => format!("до {}{suffix}", format_number(b)),
    }
}
pub fn location_label(id: &str) -> Option<String> {
    let p: Vec<_> = id.split(':').collect();
    let r = regions();
    let index = p.get(1)?.parse::<usize>().ok()?;
    let region = r.get(index)?;
    if p[0] == "r" {
        Some(if index == 0 {
            "Ереван целиком".into()
        } else {
            format!("{} (весь регион)", region["name"].as_str()?)
        })
    } else {
        Some(
            region["places"]
                .get(p.get(2)?.parse::<usize>().ok()?)?
                .as_str()?
                .to_owned(),
        )
    }
}
pub fn format_locations(ids: &Value) -> String {
    let labels: Vec<_> = ids
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(location_label)
        .collect();
    if labels.is_empty() {
        return "без ограничений".into();
    }
    let mut result = labels
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if labels.len() > 3 {
        result.push_str(&format!(" и ещё {}", labels.len() - 3));
    }
    result
}
pub fn format_message(a: &Value, channel: bool) -> String {
    let p = &a["price"];
    let normalized = p.get("originalAmount").is_some();
    let amount = if normalized {
        &p["originalAmount"]
    } else {
        &p["amount"]
    };
    let code = if normalized {
        p["originalCurrency"].as_str()
    } else {
        p["currency"].as_str()
    };
    let currency = if normalized {
        code.map(|s| match source::currency_code(s) {
            Some("AMD") => "֏",
            Some("USD") => "$",
            Some("EUR") => "€",
            Some("RUB") => "₽",
            Some("GBP") => "£",
            _ => s,
        })
    } else {
        code
    };
    let price = match (amount.as_f64(), currency) {
        (Some(n), Some(c)) if !c.is_empty() => format!("{} {c}", format_number(n)),
        _ => "не указана".into(),
    };
    let nonempty = |key: &str, fallback: &str| {
        a[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback)
            .to_owned()
    };
    let title = nonempty(
        "title",
        &format!(
            "{} {}",
            if a["kind"] == "house" {
                "Дом"
            } else {
                "Квартира"
            },
            a["itemId"].as_str().unwrap_or("")
        ),
    );
    let rooms = if a["rooms"].is_null() {
        "не указано".into()
    } else {
        display(&a["rooms"])
    };
    let area = if a["areaSqM"].is_null() {
        "не указана".into()
    } else {
        format!("{} м²", display(&a["areaSqM"]))
    };
    let mut out = format!(
        "{title}\nЦена: {price}\nМестоположение: {}\nКоличество комнат: {rooms}\nПлощадь: {area}\nЭтаж: {}\n{}",
        nonempty("location", "не указано"),
        nonempty("floor", "не указан"),
        a["url"].as_str().unwrap_or("")
    );
    if channel {
        out.push_str("\n\n");
        out.push_str(&channel_hashtags(a).join(" "));
    }
    out
}
fn hashtag(s: Option<&str>, fallback: &str) -> String {
    let Some(s) = s else {
        return fallback.into();
    };
    let mut out = String::new();
    for c in folded(s).chars() {
        let c = if c.is_whitespace() || c == '-' {
            '_'
        } else {
            c
        };
        if (c.is_alphanumeric() || c == '_') && !(c == '_' && out.ends_with('_')) {
            out.push(c);
        }
    }
    let s = out.trim_matches('_');
    if s.is_empty() {
        fallback.into()
    } else {
        format!("#{s}")
    }
}
pub fn channel_hashtags(a: &Value) -> Vec<String> {
    let location = a["location"].as_str().unwrap_or("");
    let normalized = folded(location);
    let parts: Vec<_> = normalized
        .split([',', '/'])
        .map(|s| folded(s.trim()))
        .collect();
    let catalog = regions();
    let mut found = None;
    for part in &parts {
        let matches: Vec<_> = catalog
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|r| {
                r["places"].as_array().unwrap().iter().filter_map(move |p| {
                    if folded(p.as_str().unwrap()) == *part {
                        Some((r["name"].as_str().unwrap(), p.as_str().unwrap()))
                    } else {
                        None
                    }
                })
            })
            .collect();
        if matches.len() == 1 {
            found = Some(matches[0]);
            break;
        }
    }
    if found.is_none() {
        for part in &parts {
            if let Some(r) = catalog
                .as_array()
                .unwrap()
                .iter()
                .find(|r| folded(r["name"].as_str().unwrap()) == *part)
            {
                let name = r["name"].as_str().unwrap();
                found = Some((name, name));
                break;
            }
        }
    }
    let region = hashtag(found.map(|v| v.0), "#регион_не_указан");
    let locality = hashtag(
        found.map(|v| v.1).or_else(|| {
            if location.trim().is_empty() {
                None
            } else {
                Some(location.trim())
            }
        }),
        "#локация_не_указана",
    );
    let mut out = vec![region.clone()];
    if locality != region {
        out.push(locality);
    }
    out.push(
        if let Some(price) = source::amd_amount(&a["price"]).filter(|v| *v > 0.0) {
            let bucket = ((price - 1.0) / 50_000.0).floor() as i64;
            format!("#цена_{}_{}", bucket * 50 + 1, (bucket + 1) * 50)
        } else {
            "#цена_не_указана".into()
        },
    );
    out.push(
        if let Some(rooms) = a["rooms"]
            .as_f64()
            .filter(|v| *v > 0.0 && v.fract() == 0.0 && *v <= 9_007_199_254_740_991.0)
        {
            format!("#{rooms}комн")
        } else {
            "#комнаты_не_указаны".into()
        },
    );
    out
}
pub fn contract(v: Value) -> Result<Value> {
    if v["op"] == "format" {
        return Ok(json!(format_message(
            &v["apartment"],
            v["channel"].as_bool().unwrap_or(false)
        )));
    }
    match v["action"].as_str().unwrap_or("normalize") {
        "channel" => parse_channel(
            v["price"].as_str().unwrap_or(""),
            v["rooms"].as_str().unwrap_or(""),
            v["locations"].as_str().unwrap_or(""),
        ),
        "match" => Ok(json!(matches(&v["apartment"], &v["filters"]))),
        "range" => parse_range(
            v["value"].as_str().unwrap_or(""),
            v["kind"].as_str().unwrap_or("price"),
        ),
        _ => Ok(normalize_filters(&v["filters"])),
    }
}
pub fn parse_channel(price: &str, rooms: &str, locations: &str) -> Result<Value> {
    let range = |s: &str, kind: &str| -> Result<Value> {
        if s.trim().is_empty() {
            return Ok(json!({"min":null,"max":null}));
        }
        let compact: String = s
            .chars()
            .filter(|c| !c.is_whitespace())
            .map(|c| if c == '–' || c == '—' { '-' } else { c })
            .collect();
        if !regex::Regex::new(r"^(?:[0-9]+|[0-9]+-[0-9]*|-[0-9]+)$")
            .unwrap()
            .is_match(&compact)
        {
            return Err(format!(
                "CHANNEL_FILTER_{kind} must be an exact, open, or closed integer range"
            )
            .into());
        }
        parse_range(&compact, kind)
    };
    let mut f = normalize_filters(&Value::Null);
    f["price"] = range(price, "price")?;
    f["rooms"] = range(rooms, "rooms")?;
    let locations = if locations.trim().is_empty() {
        "region:Ереван"
    } else {
        locations.trim()
    };
    if folded(locations) == "all" {
        return Ok(f);
    }
    let catalog = regions();
    let mut ids: Vec<String> = vec![];
    for selector in locations.split(',').map(str::trim) {
        let (kind, name) = selector
            .split_once(':')
            .ok_or("CHANNEL_FILTER_LOCATIONS selector requires region or place")?;
        let name = folded(name.trim());
        let mut found = vec![];
        for (i, r) in catalog.as_array().unwrap().iter().enumerate() {
            match kind.trim().to_lowercase().as_str() {
                "region" => {
                    if folded(r["name"].as_str().unwrap()) == name {
                        found.push(format!("r:{i}"));
                    }
                }
                "place" => {
                    for (j, p) in r["places"].as_array().unwrap().iter().enumerate() {
                        if folded(p.as_str().unwrap()) == name {
                            found.push(format!("p:{i}:{j}"));
                        }
                    }
                }
                _ => return Err("CHANNEL_FILTER_LOCATIONS invalid selector type".into()),
            }
        }
        if found.len() != 1 {
            return Err("CHANNEL_FILTER_LOCATIONS unknown or ambiguous selector".into());
        }
        let id = found.remove(0);
        if ids.contains(&id) {
            return Err("CHANNEL_FILTER_LOCATIONS duplicate selector".into());
        }
        ids.push(id);
    }
    if ids.iter().any(|id| {
        id.starts_with("p:") && ids.contains(&format!("r:{}", id.split(':').nth(1).unwrap()))
    }) {
        return Err("CHANNEL_FILTER_LOCATIONS cannot combine region and place".into());
    }
    f["locations"] = json!(ids);
    Ok(f)
}
