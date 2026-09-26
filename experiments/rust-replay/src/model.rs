use crate::Result;
use chrono::{DateTime, NaiveDate};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub url: String,
    pub price: i64,
    pub original_amount: i64,
    pub currency: String,
    pub location: String,
    pub rooms: i64,
    pub area_sq_m: i64,
    pub floor: String,
    pub posted_at: i64,
}
#[derive(Deserialize)]
pub struct Bounds {
    min: i64,
    max: i64,
}
#[derive(Deserialize)]
pub struct Filter {
    kinds: Vec<String>,
    price: Option<Bounds>,
    rooms: Option<Bounds>,
    locations: Vec<String>,
}
impl Filter {
    pub fn matches(&self, l: &Listing) -> bool {
        self.kinds.contains(&l.kind)
            && self
                .price
                .as_ref()
                .is_none_or(|b| (b.min..=b.max).contains(&l.price))
            && self
                .rooms
                .as_ref()
                .is_none_or(|b| (b.min..=b.max).contains(&l.rooms))
            && (self.locations.is_empty() || self.locations.contains(&l.location))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub clock_epoch: String,
    pub initial_delivery_limit: usize,
    pub seed: Seed,
    pub seed_decisions: SeedDecisions,
    pub recipients: Recipients,
    pub exchange_rates: ExchangeRates,
    pub transport: Transport,
    pub phases: Vec<Phase>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    pub timestamp: String,
    pub decisions_per_recipient: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedDecisions {
    pub listing_ids: Vec<String>,
    pub absent_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipients {
    pub filters_by_group: Vec<Filter>,
}
#[derive(Deserialize)]
pub struct ExchangeRates {
    pub rates: BTreeMap<String, Rate>,
}
#[derive(Deserialize)]
pub struct Rate {
    amount: f64,
    rate: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transport {
    pub latency_ms: f64,
    pub global_attempts_per_second: f64,
    pub recipient_messages_per_minute: f64,
    pub recipient_burst: f64,
    pub retry_after_ms: f64,
    pub retry_recipients_modulo: usize,
    pub max_attempts: usize,
}
#[derive(Deserialize)]
pub struct Phase {
    pub name: String,
    pub action: String,
    pub ids: Vec<String>,
    pub pages: BTreeMap<String, String>,
    #[serde(default)]
    pub repeats: usize,
}
pub fn timestamp(s: &str) -> Result<i64> {
    Ok(DateTime::parse_from_rfc3339(s)?.timestamp_millis())
}

pub fn parse_page(html: &str, kind: &str, manifest: &Manifest) -> Result<Vec<Listing>> {
    let document = Html::parse_document(html);
    let cards = Selector::parse("#contentr a.category-data-list-card__destination").unwrap();
    let mut listings = Vec::new();
    for card in document.select(&cards) {
        let field = |class: &str| -> Result<String> {
            let selector = Selector::parse(class).map_err(|_| "invalid selector")?;
            let node = card.select(&selector).next().ok_or("missing card field")?;
            Ok(node.text().collect::<String>().trim().to_owned())
        };
        let href = card.value().attr("href").ok_or("missing href")?;
        let id = href
            .strip_prefix("/ru/item/")
            .ok_or("invalid listing URL")?;
        id.parse::<i64>()?;
        let price = field(".p")?;
        let parts: Vec<_> = price.split_whitespace().collect();
        if parts.len() != 2 {
            return Err("invalid price".into());
        }
        let amount: i64 = parts[0].parse()?;
        let canonical = if parts[1] == "AMD" {
            amount
        } else {
            let rate = manifest
                .exchange_rates
                .rates
                .get(parts[1])
                .ok_or_else(|| format!("missing exchange rate {}", parts[1]))?;
            if rate.amount <= 0.0 || rate.rate <= 0.0 {
                return Err("invalid exchange rate".into());
            }
            (amount as f64 * rate.rate / rate.amount).round() as i64
        };
        let details = field(".at")?;
        let details: Vec<_> = details.split(" · ").collect();
        if details.len() != 3 {
            return Err("invalid fixture details".into());
        }
        let rooms = details[0]
            .strip_suffix(" ком.")
            .ok_or("invalid rooms")?
            .parse()?;
        let area = details[1]
            .strip_suffix(" кв.м.")
            .ok_or("invalid area")?
            .parse()?;
        let floor = details[2]
            .strip_suffix(" этаж")
            .ok_or("invalid floor")?
            .to_owned();
        let date = field(".d")?;
        let date = date
            .split_once("Сентябрь ")
            .ok_or("unsupported fixture month")?
            .1;
        let date: Vec<_> = date.split(", ").collect();
        if date.len() != 3 {
            return Err("invalid fixture date".into());
        }
        let posted_at = NaiveDate::from_ymd_opt(date[1].parse()?, 9, date[0].parse()?)
            .ok_or("invalid calendar date")?
            .and_hms_milli_opt(23, 59, 59, 999)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        let title = field(".dltitle")?;
        if title.is_empty() {
            return Err("empty title".into());
        }
        listings.push(Listing {
            id: id.into(),
            kind: kind.into(),
            title,
            url: format!("https://www.list.am{href}"),
            price: canonical,
            original_amount: amount,
            currency: parts[1].into(),
            location: field(".l")?,
            rooms,
            area_sq_m: area,
            floor,
            posted_at,
        });
    }
    Ok(listings)
}
