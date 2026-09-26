package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"
)

type Listing struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	Title          string `json:"title"`
	URL            string `json:"url"`
	Price          int    `json:"price"`
	OriginalAmount int    `json:"originalAmount"`
	Currency       string `json:"currency"`
	Location       string `json:"location"`
	Rooms          int    `json:"rooms"`
	AreaSqM        int    `json:"areaSqM"`
	Floor          string `json:"floor"`
	PostedAt       int64  `json:"postedAt"`
}
type Bounds struct{ Min, Max int }
type Filter struct {
	Kinds     []string
	Price     *Bounds
	Rooms     *Bounds
	Locations []string
}

func (f Filter) Matches(l Listing) bool {
	kind := false
	for _, k := range f.Kinds {
		if k == l.Kind {
			kind = true
		}
	}
	if !kind || f.Price != nil && (l.Price < f.Price.Min || l.Price > f.Price.Max) || f.Rooms != nil && (l.Rooms < f.Rooms.Min || l.Rooms > f.Rooms.Max) {
		return false
	}
	if len(f.Locations) > 0 {
		for _, v := range f.Locations {
			if v == l.Location {
				return true
			}
		}
		return false
	}
	return true
}

type Phase struct {
	Name, Action string
	IDs          []string
	Pages        map[string]string
	Repeats      int
}
type Manifest struct {
	Version              int
	ClockEpoch           string
	InitialDeliveryLimit int
	Seed                 struct {
		Timestamp             string
		DecisionsPerRecipient int
	}
	SeedDecisions struct{ ListingIDs, AbsentIDs []string }
	Recipients    struct{ FiltersByGroup []Filter }
	ExchangeRates struct {
		Rates map[string]struct{ Amount, Rate float64 }
	}
	Transport struct{ LatencyMs, GlobalAttemptsPerSecond, RecipientMessagesPerMinute, RecipientBurst, RetryAfterMs, RetryRecipientsModulo, MaxAttempts int }
	Phases    []Phase
}

func readManifest(dir string) (Manifest, error) {
	var m Manifest
	b, e := os.ReadFile(dir + "/manifest.json")
	if e == nil {
		e = json.Unmarshal(b, &m)
	}
	if e == nil && (m.Version != 1 || len(m.Recipients.FiltersByGroup) != 4 || m.Transport.GlobalAttemptsPerSecond <= 0 || m.Transport.RecipientMessagesPerMinute <= 0 || m.Transport.RetryRecipientsModulo <= 0 || m.Transport.MaxAttempts < 2) {
		e = fmt.Errorf("unsupported replay contract")
	}
	return m, e
}
func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}
func nodeText(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(nodeText(c))
	}
	return strings.TrimSpace(b.String())
}

var detailsPattern = regexp.MustCompile(`^(\d+) ком\. · (\d+) кв\.м\. · (\d+/\d+) этаж$`)
var datePattern = regexp.MustCompile(`Сентябрь (\d+), (\d{4}), \d{2}:\d{2}$`)

func parsePage(r io.Reader, kind string, m Manifest) ([]Listing, error) {
	doc, err := html.Parse(r)
	if err != nil {
		return nil, err
	}
	list := []Listing{}
	var walk func(*html.Node, bool) error
	walk = func(n *html.Node, regular bool) error {
		regular = regular || attr(n, "id") == "contentr"
		if regular && n.Data == "a" && attr(n, "class") == "category-data-list-card__destination" {
			fields := map[string]string{}
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				fields[attr(c, "class")] = nodeText(c)
			}
			href := attr(n, "href")
			id := strings.TrimPrefix(href, "/ru/item/")
			if _, e := strconv.Atoi(id); e != nil || id == href {
				return fmt.Errorf("invalid listing URL %q", href)
			}
			price := strings.Fields(fields["p"])
			if len(price) != 2 {
				return fmt.Errorf("invalid price")
			}
			amount, e := strconv.Atoi(price[0])
			if e != nil {
				return e
			}
			canonical := amount
			if price[1] != "AMD" {
				rate, ok := m.ExchangeRates.Rates[price[1]]
				if !ok || rate.Amount <= 0 || rate.Rate <= 0 {
					return fmt.Errorf("missing exchange rate %s", price[1])
				}
				canonical = int(math.Round(float64(amount) * rate.Rate / rate.Amount))
			}
			detail := detailsPattern.FindStringSubmatch(fields["at"])
			date := datePattern.FindStringSubmatch(fields["d"])
			if detail == nil || date == nil || fields["dltitle"] == "" {
				return fmt.Errorf("invalid fixture card %s", id)
			}
			rooms, _ := strconv.Atoi(detail[1])
			area, _ := strconv.Atoi(detail[2])
			day, _ := strconv.Atoi(date[1])
			year, _ := strconv.Atoi(date[2])
			posted := time.Date(year, 9, day, 23, 59, 59, 999000000, time.UTC)
			list = append(list, Listing{id, kind, fields["dltitle"], "https://www.list.am" + href, canonical, amount, price[1], fields["l"], rooms, area, detail[3], posted.UnixMilli()})
			return nil
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if e := walk(c, regular); e != nil {
				return e
			}
		}
		return nil
	}
	err = walk(doc, false)
	return list, err
}
