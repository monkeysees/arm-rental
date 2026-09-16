package main

import (
	"fmt"
	"math"
	"reflect"
	"sort"
	"time"
)

type Distribution struct {
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
	Max float64 `json:"max"`
}
type PhaseResult struct {
	FirstRecipientProgressMs Distribution        `json:"firstRecipientProgressMs"`
	MaximumRecipientLead     int                 `json:"maximumRecipientLead"`
	RecipientsWithProgress   int                 `json:"recipientsWithProgress"`
	QueueAgeP99Ms            float64             `json:"queueAgeP99Ms"`
	CpuMs                    float64             `json:"cpuMs"`
	QueueAgeOffsetMs         float64             `json:"queueAgeOffsetMs"`
	QueueAgeP50Ms            float64             `json:"queueAgeP50Ms"`
	QueueAgeP95Ms            float64             `json:"queueAgeP95Ms"`
	QueueAgeMaxMs            float64             `json:"queueAgeMaxMs"`
	ThroughputPerSecond      *float64            `json:"throughputPerSecond"`
	Name                     string              `json:"name"`
	Sent                     int                 `json:"sent"`
	Announcements            int                 `json:"announcements"`
	Retries                  int                 `json:"retries"`
	Attempts                 int                 `json:"attempts"`
	RecipientsAsserted       int                 `json:"recipientsAsserted"`
	ClassifiedRecipients     int                 `json:"classifiedRecipients"`
	DeliveriesByProfile      [][]string          `json:"deliveriesByProfile"`
	PayloadsByProfile        [][]Listing         `json:"payloadsByProfile"`
	ClassificationsByProfile []map[string]string `json:"classificationsByProfile"`
	ClassificationWallMs     float64             `json:"classificationWallMs"`
	WallMs                   float64             `json:"wallMs"`
	DrainMs                  float64             `json:"drainMs"`
	FirstProgressMaxMs       float64             `json:"firstProgressMaxMs"`
	MaxInFlight              int                 `json:"maxInFlight"`
	RateLimitsVerified       bool                `json:"rateLimitsVerified"`
}

// One event loop owns SQLite. Each turn starts at most one send per ready user;
// waits have deadlines, and only transport latency occupies one of eight slots.
func (s *Store) deliver(m Manifest, users int, catchup bool, mode string, now int64, out *PhaseResult) error {
	type attempt struct {
		at    float64
		retry bool
	}
	history := make([][]attempt, users)
	lastAttempt := -1e30
	type recipient struct {
		tokens, refilled, ready     float64
		announcement, retried, done bool
		attempts                    int
		sent                        []Listing
	}
	type flight struct {
		user    int
		listing *Listing
		end     float64
		retry   bool
		fail    bool
	}
	states := make([]recipient, users)
	for i := range states {
		states[i] = recipient{tokens: float64(m.Transport.RecipientBurst), announcement: catchup, sent: []Listing{}}
	}
	ages := []float64{}
	first := []float64{}
	progressCounts := make([]int, 1)
	progressCounts[0] = users
	minimumProgress, maximumProgress := 0, 0
	start := time.Now()
	clock := 0.0
	global := 0.0
	cursor := 0
	finished := 0
	flights := []flight{}
	for finished < users || len(flights) > 0 {
		if mode == "wall" {
			clock = float64(time.Since(start).Microseconds()) / 1000
		}
		pending := flights[:0]
		for _, f := range flights {
			if f.end > clock {
				pending = append(pending, f)
				continue
			}
			r := &states[f.user]
			if f.fail {
				r.done = true
				finished++
				continue
			}
			if f.retry {
				r.retried = true
				r.ready = clock + float64(m.Transport.RetryAfterMs)
				out.Retries++
				continue
			}
			r.ready = clock
			r.attempts = 0
			if f.listing == nil {
				r.announcement = false
				out.Announcements++
			} else {
				if e := s.acknowledge(f.user, f.listing.ID, now); e != nil {
					return e
				}
				if len(r.sent) == 0 {
					progress := clock
					if mode == "wall" {
						progress += out.ClassificationWallMs
					}
					first = append(first, progress)
					if clock > out.FirstProgressMaxMs {
						out.FirstProgressMaxMs = clock
					}
				}
				progressCounts[len(r.sent)]--
				if len(progressCounts) == len(r.sent)+1 {
					progressCounts = append(progressCounts, 0)
				}
				progressCounts[len(r.sent)+1]++
				for progressCounts[minimumProgress] == 0 {
					minimumProgress++
				}
				if len(r.sent)+1 > maximumProgress {
					maximumProgress = len(r.sent) + 1
				}
				if maximumProgress-minimumProgress > out.MaximumRecipientLead {
					out.MaximumRecipientLead = maximumProgress - minimumProgress
				}
				r.sent = append(r.sent, *f.listing)
				out.Sent++
				age := clock + out.QueueAgeOffsetMs
				if mode == "wall" {
					age += out.ClassificationWallMs
				}
				ages = append(ages, age)
			}
		}
		flights = pending
		launched := false
		next := 1e30
		for _, f := range flights {
			if f.end < next {
				next = f.end
			}
		}
		for scanned := 0; scanned < users && len(flights) < 8; scanned++ {
			if clock < global {
				if global < next {
					next = global
				}
				break
			}
			u := cursor
			cursor = (cursor + 1) % users
			// A retry whose deadline has elapsed gets its first progress before another sweep.
			for candidate := 0; candidate < users; candidate++ {
				waiting := &states[candidate]
				if waiting.retried && !waiting.done && len(waiting.sent) == 0 && waiting.ready <= clock {
					u = candidate
					break
				}
			}
			r := &states[u]
			if r.done {
				continue
			}
			if r.ready > clock {
				if r.ready < next {
					next = r.ready
				}
				continue
			}
			l, e := s.next(u)
			if e != nil {
				return e
			}
			if l == nil && !r.announcement {
				r.done = true
				finished++
				continue
			}
			r.tokens += (clock - r.refilled) * float64(m.Transport.RecipientMessagesPerMinute) / 60000
			if r.tokens > float64(m.Transport.RecipientBurst) {
				r.tokens = float64(m.Transport.RecipientBurst)
			}
			r.refilled = clock
			// Fractional refills can land a few ulps below one at the deadline.
			if r.attempts == 0 && r.tokens+1e-9 < 1 {
				r.ready = clock + (1-r.tokens)*60000/float64(m.Transport.RecipientMessagesPerMinute)
				if r.ready < next {
					next = r.ready
				}
				continue
			}
			if clock-lastAttempt+0.000001 < 1000/float64(m.Transport.GlobalAttemptsPerSecond) {
				return fmt.Errorf("global transport rate exceeded")
			}
			lastAttempt = clock
			history[u] = append(history[u], attempt{clock, r.attempts > 0})
			if r.attempts == 0 {
				r.tokens--
				if r.tokens < 0 {
					r.tokens = 0
				}
			}
			r.attempts++
			if r.attempts > m.Transport.MaxAttempts {
				return fmt.Errorf("retry budget exceeded")
			}
			if r.announcement {
				l = nil
			}
			retry := catchup && l != nil && len(r.sent) == 0 && u%m.Transport.RetryRecipientsModulo == 0 && !r.retried
			end := clock + float64(m.Transport.LatencyMs)
			flights = append(flights, flight{u, l, end, retry, out.Name == "interrupted" && len(r.sent) == 2})
			r.ready = 1e30
			global = clock + 1000/float64(m.Transport.GlobalAttemptsPerSecond)
			out.Attempts++
			launched = true
			if len(flights) > out.MaxInFlight {
				out.MaxInFlight = len(flights)
			}
			break
		}
		if finished == users && len(flights) == 0 {
			break
		}
		if launched {
			continue
		}
		if next == 1e30 {
			return fmt.Errorf("scheduler deadlock")
		}
		if mode == "wall" {
			delay := next - float64(time.Since(start).Microseconds())/1000
			if delay > 0 {
				time.Sleep(time.Duration(delay * 1e6))
			}
		} else {
			clock = next
		}
	}
	out.DrainMs = clock
	out.FirstRecipientProgressMs = distribution(first)
	out.RecipientsWithProgress = len(first)
	ageDistribution := distribution(ages)
	out.QueueAgeP50Ms = ageDistribution.P50
	out.QueueAgeP95Ms = ageDistribution.P95
	out.QueueAgeP99Ms = ageDistribution.P99
	out.QueueAgeMaxMs = ageDistribution.Max
	for _, attempts := range history {
		logical := []float64{}
		for i, a := range attempts {
			if a.retry {
				if i == 0 || a.at-attempts[i-1].at+0.000001 < float64(m.Transport.LatencyMs+m.Transport.RetryAfterMs) {
					return fmt.Errorf("retry deadline violated")
				}
			} else {
				logical = append(logical, a.at)
			}
		}
		for i, first := range logical {
			for j := i; j < len(logical); j++ {
				allowed := float64(m.Transport.RecipientBurst) + (logical[j]-first)*float64(m.Transport.RecipientMessagesPerMinute)/60000
				if float64(j-i+1) > allowed+0.000001 {
					return fmt.Errorf("recipient transport rate exceeded")
				}
			}
		}
	}
	out.RateLimitsVerified = true
	out.DeliveriesByProfile = make([][]string, 4)
	out.PayloadsByProfile = make([][]Listing, 4)
	for u, r := range states {
		ids := []string{}
		for _, l := range r.sent {
			ids = append(ids, l.ID)
		}
		if u < 4 {
			out.DeliveriesByProfile[u] = ids
			out.PayloadsByProfile[u] = r.sent
		} else if !reflect.DeepEqual(r.sent, out.PayloadsByProfile[u%4]) {
			return fmt.Errorf("recipient %d payload/order differs", u)
		}
		out.RecipientsAsserted++
	}
	return nil
}

func distribution(values []float64) Distribution {
	sort.Float64s(values)
	if len(values) == 0 {
		return Distribution{}
	}
	quantile := func(q float64) float64 { return values[int(math.Ceil(float64(len(values))*q))-1] }
	return Distribution{quantile(.5), quantile(.95), quantile(.99), quantile(1)}
}
