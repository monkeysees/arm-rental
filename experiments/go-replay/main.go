package main

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Result struct {
	Version   int            `json:"version"`
	Status    string         `json:"status"`
	Scope     string         `json:"scope"`
	Runtime   string         `json:"runtime"`
	Mode      string         `json:"mode"`
	Workload  map[string]int `json:"workload"`
	Phases    []PhaseResult  `json:"phases"`
	Restart   map[string]any `json:"restart"`
	Resources map[string]any `json:"resources"`
}

func cgroup(name string) any {
	b, e := os.ReadFile("/sys/fs/cgroup/" + name)
	if e != nil {
		return nil
	}
	v, e := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if e != nil {
		return strings.TrimSpace(string(b))
	}
	return v
}
func Replay(directory, database string, users int, mode string, stage string) (Result, error) {
	resumeStartedAt := time.Now().UnixMilli()
	result := Result{Version: 1, Scope: "go-full-contract", Runtime: runtime.Version(), Mode: mode}
	if directory == "" || database == "" {
		return result, fmt.Errorf("--fixtures and --database are required")
	}
	if (users != 4 && users != 500 && users != 1000) || (mode != "virtual" && mode != "wall") {
		return result, fmt.Errorf("use --users 500|1000 (4 diagnostic), --mode virtual|wall")
	}
	if stage != "exercise" && stage != "resume" {
		return result, fmt.Errorf("invalid stage")
	}
	_, statErr := os.Stat(database)
	if stage == "exercise" && !os.IsNotExist(statErr) {
		return result, fmt.Errorf("database must not exist")
	}
	if stage == "resume" && statErr != nil {
		return result, fmt.Errorf("resume requires existing database")
	}
	m, e := readManifest(directory)
	if e != nil {
		return result, e
	}
	epoch, e := time.Parse(time.RFC3339, m.ClockEpoch)
	if e != nil {
		return result, e
	}
	s, e := openStore(database)
	if e != nil {
		return result, e
	}
	defer func() {
		if s != nil && stage != "exercise" {
			s.db.Close()
		}
	}()
	result.Workload = map[string]int{"users": users, "decisionsPerRecipient": m.Seed.DecisionsPerRecipient}
	start := time.Now()
	result.Resources = map[string]any{}
	result.Restart = map[string]any{}
	snapshots := []map[string]any{memorySnapshot("open")}
	var historyBefore string
	var interruptedDrain float64
	var interruptedAt int64
	if stage == "resume" {
		if e = s.db.QueryRow("SELECT drain,at,history FROM recovery WHERE id=1").Scan(&interruptedDrain, &interruptedAt, &historyBefore); e != nil {
			return result, e
		}
		if e = validateInterrupted(s, m, users); e != nil {
			return result, e
		}
		current, err := s.historyDigest()
		if err != nil {
			return result, err
		}
		if current != historyBefore {
			return result, fmt.Errorf("retained history changed before resume")
		}
		result.Restart["acknowledgedPrefixPreserved"] = true
	}
	reached := false
	for _, phase := range m.Phases {
		if phase.Name == "resumed" {
			reached = true
		}
		if stage == "exercise" && reached {
			break
		}
		if stage == "resume" && !reached {
			continue
		}
		repeats := phase.Repeats
		if repeats == 0 {
			repeats = 1
		}
		for repeat := 0; repeat < repeats; repeat++ {
			started := time.Now()
			cpuStart := cpuMs()
			out := PhaseResult{Name: phase.Name}
			list := []Listing{}
			for _, kind := range []string{"apartment", "house"} {
				file, e := os.Open(filepath.Join(directory, phase.Pages[kind]))
				if e != nil {
					return result, e
				}
				parsed, e := parsePage(file, kind, m)
				file.Close()
				if e != nil {
					return result, e
				}
				list = append(list, parsed...)
			}
			changed, e := s.crawl(list)
			if e != nil {
				return result, e
			}
			delivery := phase.Action == "deliver" || phase.Name == "catchup" || phase.Name == "interrupted" || phase.Name == "resumed"
			if delivery {
				if e = s.classify(m, users, changed, phase.Name == "catchup", epoch.UnixMilli()); e != nil {
					return result, e
				}
				if phase.Name == "resumed" {
					out.QueueAgeOffsetMs = interruptedDrain + 1000
					if mode == "wall" {
						out.QueueAgeOffsetMs = interruptedDrain + float64(resumeStartedAt-interruptedAt)
					}
				}
				out.ClassificationWallMs = float64(time.Since(started).Microseconds()) / 1000
				if e = s.deliver(m, users, phase.Name == "catchup", mode, epoch.UnixMilli(), &out); e != nil {
					return result, e
				}
				if e = observe(s, users, phase.IDs, &out); e != nil {
					return result, e
				}
			}
			out.CpuMs = cpuMs() - cpuStart
			out.WallMs = float64(time.Since(started).Microseconds()) / 1000
			if mode == "wall" && out.WallMs > 0 {
				throughput := float64(out.Sent) * 1000 / out.WallMs
				out.ThroughputPerSecond = &throughput
			}
			result.Phases = append(result.Phases, out)
			snapshots = append(snapshots, memorySnapshot(phase.Name))
			if phase.Name == "interrupted" {
				interruptedAt = time.Now().UnixMilli()
				interruptedDrain = out.DrainMs
				if mode == "wall" {
					interruptedDrain += out.ClassificationWallMs
				}
				historyBefore, e = s.historyDigest()
				if e != nil {
					return result, e
				}
				if _, e = s.db.Exec("CREATE TABLE recovery(id INTEGER PRIMARY KEY,drain REAL,at INTEGER,history TEXT); INSERT INTO recovery VALUES(1,?,?,?)", interruptedDrain, interruptedAt, historyBefore); e != nil {
					return result, e
				}
				result.Resources["interruptionDrainMs"] = interruptedDrain
				result.Resources["interruptedAtUnixMs"] = interruptedAt
			}
			if phase.Name == "seed" {
				seedStart := time.Now()
				seedCPU := cpuMs()
				if e = s.seed(m, users); e != nil {
					return result, e
				}
				result.Phases = append(result.Phases, PhaseResult{Name: "seed-decisions", CpuMs: cpuMs() - seedCPU, WallMs: float64(time.Since(seedStart).Microseconds()) / 1000})
				snapshots = append(snapshots, memorySnapshot("seed-decisions"))
			}
		}
	}
	if stage == "resume" {
		current, err := s.historyDigest()
		if err != nil {
			return result, err
		}
		if current != historyBefore {
			return result, fmt.Errorf("retained history changed during resume")
		}
	}
	var count int
	if e = s.db.QueryRow("SELECT count(*) FROM decisions").Scan(&count); e != nil {
		return result, e
	}
	added := 80
	expected := users * (m.Seed.DecisionsPerRecipient + added)
	if count != expected {
		return result, fmt.Errorf("retained decisions: %d, want %d", count, expected)
	}
	stamp, e := time.Parse(time.RFC3339, m.Seed.Timestamp)
	if e != nil {
		return result, e
	}
	var absentCount, invalidAbsent int
	if len(m.SeedDecisions.AbsentIDs) == 0 {
		return result, fmt.Errorf("missing absent history")
	}
	e = s.db.QueryRow(`SELECT count(*),coalesce(sum(CASE WHEN at!=? OR revision!=1 OR status!=CASE WHEN id%4=user%4 THEN 1 ELSE 2 END THEN 1 ELSE 0 END),0) FROM decisions WHERE id BETWEEN ? AND ?`, stamp.UnixMilli(), m.SeedDecisions.AbsentIDs[0], m.SeedDecisions.AbsentIDs[len(m.SeedDecisions.AbsentIDs)-1]).Scan(&absentCount, &invalidAbsent)
	if e != nil {
		return result, e
	}
	if absentCount != users*len(m.SeedDecisions.AbsentIDs) || invalidAbsent != 0 {
		return result, fmt.Errorf("absent decisions changed")
	}
	var usage syscall.Rusage
	if e = syscall.Getrusage(syscall.RUSAGE_SELF, &usage); e != nil {
		return result, e
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	var sqliteVersion string
	if e = s.db.QueryRow("SELECT sqlite_version()").Scan(&sqliteVersion); e != nil {
		return result, e
	}
	metrics := map[string]any{"wallMs": float64(time.Since(start).Microseconds()) / 1000, "cpuMs": float64(usage.Utime.Sec+usage.Stime.Sec)*1000 + float64(usage.Utime.Usec+usage.Stime.Usec)/1000, "processPeakRssBytes": usage.Maxrss * 1024, "goHeapBytes": mem.HeapAlloc, "primaryRamBytes": cgroup("memory.peak"), "memoryLimit": cgroup("memory.max"), "swapLimit": cgroup("memory.swap.max"), "cpuLimit": cgroup("cpu.max"), "sqliteVersion": sqliteVersion, "decisionRows": count}
	for k, v := range metrics {
		result.Resources[k] = v
	}
	result.Resources["memorySnapshots"] = snapshots
	var pending int
	if e = s.db.QueryRow("SELECT count(*) FROM decisions WHERE status=0").Scan(&pending); e != nil {
		return result, e
	}
	result.Resources["pendingRows"] = pending
	if stage == "resume" && pending != 0 {
		return result, fmt.Errorf("pending suffix remains")
	}
	for _, suffix := range []string{"", "-wal"} {
		if info, e := os.Stat(database + suffix); e == nil {
			result.Resources["database"+suffix+"Bytes"] = info.Size()
		}
	}
	if stage == "resume" {
		result.Restart["uncleanExitCode"] = 23
		result.Restart["unsentSuffixDelivered"] = true
	}
	if stage == "exercise" {
		interruptedAt = time.Now().UnixMilli()
		if _, e = s.db.Exec("UPDATE recovery SET at=? WHERE id=1", interruptedAt); e != nil {
			return result, e
		}
		result.Resources["interruptedAtUnixMs"] = interruptedAt
	}
	result.Status = "passed"
	return result, nil
}
func observe(s *Store, users int, ids []string, out *PhaseResult) error {
	out.ClassificationsByProfile = make([]map[string]string, 4)
	for u := 0; u < users; u++ {
		observed, e := s.classifications(u, ids)
		if e != nil {
			return e
		}
		if u < 4 {
			out.ClassificationsByProfile[u] = observed
		} else if !reflect.DeepEqual(observed, out.ClassificationsByProfile[u%4]) {
			return fmt.Errorf("recipient %d classification differs", u)
		}
		out.ClassifiedRecipients++
	}
	return nil
}
func main() {
	fixtures := flag.String("fixtures", "", "exported contract directory")
	database := flag.String("database", "", "new offline SQLite file")
	users := flag.Int("users", 500, "500 or 1000 recipients (4 diagnostic)")
	mode := flag.String("mode", "virtual", "virtual or wall")
	stage := flag.String("stage", "exercise", "exercise or resume")
	flag.Parse()
	result, e := Replay(*fixtures, *database, *users, *mode, *stage)
	if e == nil {
		e = json.NewEncoder(os.Stdout).Encode(result)
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	if *stage == "exercise" {
		os.Exit(23)
	}
}

func memorySnapshot(phase string) map[string]any {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	var usage syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	var resident int64
	if data, e := os.ReadFile("/proc/self/statm"); e == nil {
		var total int64
		fmt.Sscan(string(data), &total, &resident)
		resident *= int64(os.Getpagesize())
	}
	return map[string]any{"processRssBytes": resident, "phase": phase, "goHeapBytes": mem.HeapAlloc, "processPeakRssBytes": usage.Maxrss * 1024, "cgroupCurrentBytes": cgroup("memory.current")}
}
func validateInterrupted(s *Store, m Manifest, users int) error {
	var ids []string
	for _, p := range m.Phases {
		if p.Name == "interrupted" {
			ids = p.IDs
		}
	}
	for u := 0; u < users; u++ {
		matches := 0
		for _, id := range ids {
			var payload string
			if e := s.db.QueryRow("SELECT payload FROM listings WHERE id=?", id).Scan(&payload); e != nil {
				return e
			}
			var l Listing
			if e := json.Unmarshal([]byte(payload), &l); e != nil {
				return e
			}
			want := 2
			if m.Recipients.FiltersByGroup[u%4].Matches(l) {
				want = 0
				if matches < 2 {
					want = 1
				}
				matches++
			}
			var actual int
			if e := s.db.QueryRow("SELECT status FROM decisions WHERE user=? AND id=?", u, id).Scan(&actual); e != nil {
				return e
			}
			if actual != want {
				return fmt.Errorf("interrupted prefix/suffix changed for user %d listing %s", u, id)
			}
		}
	}
	return nil
}

func cpuMs() float64 {
	var usage syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	return float64(usage.Utime.Sec+usage.Stime.Sec)*1000 + float64(usage.Utime.Usec+usage.Stime.Usec)/1000
}

// Stream all retained and catch-up decisions, including skipped history, without loading them.
func (s *Store) historyDigest() (string, error) {
	rows, err := s.db.Query("SELECT user,id,status,revision,at FROM decisions WHERE id<400000 OR id>=400032 ORDER BY user,id")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	digest := sha256.New()
	for rows.Next() {
		var user, id, status, revision, at int64
		if err = rows.Scan(&user, &id, &status, &revision, &at); err != nil {
			return "", err
		}
		fmt.Fprintf(digest, "%d,%d,%d,%d,%d\n", user, id, status, revision, at)
	}
	return fmt.Sprintf("%x", digest.Sum(nil)), rows.Err()
}
