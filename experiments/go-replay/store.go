package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type Store struct{ db *sql.DB }

func openStore(file string) (*Store, error) {
	db, e := sql.Open("sqlite3", file+"?_journal_mode=WAL&_synchronous=FULL&_busy_timeout=5000")
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	_, e = db.Exec(`CREATE TABLE IF NOT EXISTS listings(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL,posted INTEGER NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS decisions(user INTEGER NOT NULL,id INTEGER NOT NULL,status INTEGER NOT NULL,revision INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(user,id)) WITHOUT ROWID, STRICT;
 CREATE INDEX IF NOT EXISTS pending ON decisions(user,status,id) WHERE status=0;
 CREATE INDEX IF NOT EXISTS recent ON listings(posted,id);`)
	if e != nil {
		db.Close()
		return nil, e
	}
	return &Store{db}, nil
}

// Compact decisions: pending=0, notified=1, filtered=2, skipped=3.
var statuses = []string{"pending", "notified", "filtered", "skipped"}

func (s *Store) crawl(list []Listing) ([]Listing, error) {
	tx, e := s.db.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	changed := []Listing{}
	for _, l := range list {
		b, e := json.Marshal(l)
		if e != nil {
			return nil, e
		}
		var old string
		var revision int
		e = tx.QueryRow("SELECT payload,revision FROM listings WHERE id=?", l.ID).Scan(&old, &revision)
		if e != nil && e != sql.ErrNoRows {
			return nil, e
		}
		if old == string(b) {
			continue
		}
		_, e = tx.Exec("INSERT INTO listings VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,posted=excluded.posted", l.ID, string(b), revision+1, l.PostedAt)
		if e != nil {
			return nil, e
		}
		changed = append(changed, l)
	}
	return changed, tx.Commit()
}
func (s *Store) seed(m Manifest, users int) error {
	stamp, e := time.Parse(time.RFC3339, m.Seed.Timestamp)
	if e != nil {
		return e
	}
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	stmt, e := tx.Prepare("INSERT INTO decisions VALUES(?,?,?,?,?)")
	if e != nil {
		return e
	}
	defer stmt.Close()
	ids := append(append([]string{}, m.SeedDecisions.ListingIDs...), m.SeedDecisions.AbsentIDs...)
	for u := 0; u < users; u++ {
		for _, id := range ids {
			var n int
			if _, e = fmt.Sscan(id, &n); e != nil {
				return e
			}
			status := 2
			if n%4 == u%4 {
				status = 1
			}
			if _, e = stmt.Exec(u, id, status, 1, stamp.UnixMilli()); e != nil {
				return e
			}
		}
	}
	return tx.Commit()
}
func (s *Store) classify(m Manifest, users int, changed []Listing, catchup bool, now int64) error {
	list := changed
	sort.Slice(list, func(i, j int) bool {
		if list[i].PostedAt != list[j].PostedAt {
			return list[i].PostedAt < list[j].PostedAt
		}
		return list[i].ID < list[j].ID
	})
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for u := 0; u < users; u++ {
		type decision struct {
			l                Listing
			revision, status int
		}
		items := []decision{}
		if catchup {
			rows, err := tx.Query(`SELECT l.payload,l.revision FROM listings l LEFT JOIN decisions d ON d.user=? AND d.id=l.id WHERE l.posted>=? AND (d.revision IS NULL OR d.revision!=l.revision) ORDER BY l.posted,l.id`, u, now-86400000)
			if err != nil {
				return err
			}
			for rows.Next() {
				var b string
				var d decision
				if err = rows.Scan(&b, &d.revision); err != nil {
					rows.Close()
					return err
				}
				if err = json.Unmarshal([]byte(b), &d.l); err != nil {
					rows.Close()
					return err
				}
				items = append(items, d)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
		}
		for _, l := range list {
			if catchup {
				break
			}
			if l.PostedAt < now-86400000 {
				continue
			}
			var revision int
			if e = tx.QueryRow("SELECT revision FROM listings WHERE id=?", l.ID).Scan(&revision); e != nil {
				return e
			}
			var oldStatus, oldRevision int
			e = tx.QueryRow("SELECT status,revision FROM decisions WHERE user=? AND id=?", u, l.ID).Scan(&oldStatus, &oldRevision)
			if e != nil && e != sql.ErrNoRows {
				return e
			}
			if e == nil && oldRevision == revision {
				continue
			}
			items = append(items, decision{l, revision, 0})
		}
		for i := range items {
			items[i].status = 2
			if m.Recipients.FiltersByGroup[u%4].Matches(items[i].l) {
				items[i].status = 0
			}
		}
		if catchup {
			count := 0
			for i := len(items) - 1; i >= 0; i-- {
				if items[i].status == 0 {
					count++
					if count > m.InitialDeliveryLimit {
						items[i].status = 3
					}
				}
			}
		}
		for _, d := range items {
			_, e = tx.Exec("INSERT INTO decisions VALUES(?,?,?,?,?) ON CONFLICT(user,id) DO UPDATE SET status=excluded.status,revision=excluded.revision,at=excluded.at", u, d.l.ID, d.status, d.revision, now)
			if e != nil {
				return e
			}
		}
	}
	return tx.Commit()
}
func (s *Store) next(user int) (*Listing, error) {
	var b string
	e := s.db.QueryRow("SELECT l.payload FROM decisions d JOIN listings l ON l.id=d.id WHERE d.user=? AND d.status=0 ORDER BY l.posted,l.id LIMIT 1", user).Scan(&b)
	if e == sql.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var l Listing
	e = json.Unmarshal([]byte(b), &l)
	return &l, e
}
func (s *Store) acknowledge(user int, id string, now int64) error {
	_, e := s.db.Exec("UPDATE decisions SET status=1,at=? WHERE user=? AND id=? AND status=0", now, user, id)
	return e
}
func (s *Store) classifications(user int, ids []string) (map[string]string, error) {
	result := map[string]string{}
	for _, id := range ids {
		var status int
		e := s.db.QueryRow("SELECT status FROM decisions WHERE user=? AND id=?", user, id).Scan(&status)
		if e != nil {
			return nil, e
		}
		result[id] = statuses[status]
	}
	return result, nil
}
