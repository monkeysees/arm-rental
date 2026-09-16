package main

import (
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
	Version   int             `json:"version"`
	Status    string          `json:"status"`
	Scope     string          `json:"scope"`
	Runtime   string          `json:"runtime"`
	Mode      string          `json:"mode"`
	Workload  map[string]int  `json:"workload"`
	Phases    []PhaseResult   `json:"phases"`
	Restart   map[string]bool `json:"restart"`
	Resources map[string]any  `json:"resources"`
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
func Replay(directory, database string, users int, mode string) (Result, error) {
	result := Result{Version: 1, Scope: "go-500-slice", Runtime: runtime.Version(), Mode: mode}
	if directory == "" || database == "" {
		return result, fmt.Errorf("--fixtures and --database are required")
	}
	if (users != 4 && users != 500) || (mode != "virtual" && mode != "wall") {
		return result, fmt.Errorf("use --users 500 (4 diagnostic), --mode virtual|wall")
	}
	if _, e := os.Stat(database); !os.IsNotExist(e) {
		return result, fmt.Errorf("database must not exist")
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
		if s != nil {
			s.db.Close()
		}
	}()
	result.Workload = map[string]int{"users": users, "decisionsPerRecipient": m.Seed.DecisionsPerRecipient}
	start := time.Now()
	for _, phase := range m.Phases {
		if phase.Name == "interrupted" {
			break
		}
		repeats := phase.Repeats
		if repeats == 0 {
			repeats = 1
		}
		for repeat := 0; repeat < repeats; repeat++ {
			started := time.Now()
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
			delivery := phase.Action == "deliver" || phase.Name == "catchup"
			if delivery {
				if e = s.classify(m, users, changed, phase.Name == "catchup", epoch.UnixMilli()); e != nil {
					return result, e
				}
				out.ClassificationWallMs = float64(time.Since(started).Microseconds()) / 1000
				if e = s.deliver(m, users, phase.Name == "catchup", mode, epoch.UnixMilli(), &out); e != nil {
					return result, e
				}
				if e = observe(s, users, phase.IDs, &out); e != nil {
					return result, e
				}
			}
			out.WallMs = float64(time.Since(started).Microseconds()) / 1000
			result.Phases = append(result.Phases, out)
			if phase.Name == "seed" {
				seedStart := time.Now()
				if e = s.seed(m, users); e != nil {
					return result, e
				}
				result.Phases = append(result.Phases, PhaseResult{Name: "seed-decisions", WallMs: float64(time.Since(seedStart).Microseconds()) / 1000})
			}
		}
	}
	// Reopen the same database and observe acknowledged decisions before replay.
	before := result.Phases[len(result.Phases)-1]
	if e = s.db.Close(); e != nil {
		return result, e
	}
	s, e = openStore(database)
	if e != nil {
		return result, e
	}
	out := PhaseResult{Name: "reopen-unchanged"}
	var catchup Phase
	for _, p := range m.Phases {
		if p.Name == "catchup" {
			catchup = p
		}
	}
	if e = observe(s, users, catchup.IDs, &out); e != nil {
		return result, e
	}
	if !reflect.DeepEqual(before.ClassificationsByProfile, out.ClassificationsByProfile) {
		return result, fmt.Errorf("reopen changed acknowledgements")
	}
	reopened := time.Now()
	list := []Listing{}
	for _, kind := range []string{"apartment", "house"} {
		f, e := os.Open(filepath.Join(directory, catchup.Pages[kind]))
		if e != nil {
			return result, e
		}
		parsed, e := parsePage(f, kind, m)
		f.Close()
		if e != nil {
			return result, e
		}
		list = append(list, parsed...)
	}
	changed, e := s.crawl(list)
	if e != nil {
		return result, e
	}
	if e = s.classify(m, users, changed, false, epoch.UnixMilli()); e != nil {
		return result, e
	}
	out.ClassificationWallMs = float64(time.Since(reopened).Microseconds()) / 1000
	if e = s.deliver(m, users, false, mode, epoch.UnixMilli(), &out); e != nil {
		return result, e
	}
	if out.Sent != 0 {
		return result, fmt.Errorf("unchanged replay duplicated acknowledgements")
	}
	out.WallMs = float64(time.Since(reopened).Microseconds()) / 1000
	result.Phases = append(result.Phases, out)
	var count int
	if e = s.db.QueryRow("SELECT count(*) FROM decisions").Scan(&count); e != nil {
		return result, e
	}
	expected := users * (m.Seed.DecisionsPerRecipient + 48)
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
	result.Resources = map[string]any{"wallMs": float64(time.Since(start).Microseconds()) / 1000, "cpuMs": float64(usage.Utime.Sec+usage.Stime.Sec)*1000 + float64(usage.Utime.Usec+usage.Stime.Usec)/1000, "processPeakRssBytes": usage.Maxrss * 1024, "goHeapBytes": mem.HeapAlloc, "primaryRamBytes": cgroup("memory.peak"), "memoryLimit": cgroup("memory.max"), "swapLimit": cgroup("memory.swap.max"), "cpuLimit": cgroup("cpu.max"), "sqliteVersion": sqliteVersion, "decisionRows": count}
	for _, suffix := range []string{"", "-wal"} {
		if info, e := os.Stat(database + suffix); e == nil {
			result.Resources["database"+suffix+"Bytes"] = info.Size()
		}
	}
	result.Restart = map[string]bool{"cleanReopen": true, "acknowledgementsPreserved": true, "unchangedSendsNothing": true}
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
	users := flag.Int("users", 500, "500 recipients (4 diagnostic)")
	mode := flag.String("mode", "virtual", "virtual or wall")
	flag.Parse()
	result, e := Replay(*fixtures, *database, *users, *mode)
	if e == nil {
		e = json.NewEncoder(os.Stdout).Encode(result)
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
