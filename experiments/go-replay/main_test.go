package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func exportFixture(t *testing.T) (string, string, string) {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	fixture := filepath.Join(dir, "fixture")
	cmd := exec.Command("node", "experiments/node-replay/export.js", fixture)
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("export: %v\n%s", err, out)
	}
	return root, dir, fixture
}
func verifyResult(t *testing.T, root, dir string, result Result, valid bool) {
	t.Helper()
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "result.json")
	if err = os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "experiments/node-replay/verify.js", file)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if (err == nil) != valid {
		t.Fatalf("verifier expected valid=%v: %v\n%s", valid, err, out)
	}
}

// The exported replay and independent verifier are the ticket's public seam.
func TestReplayContract(t *testing.T) {
	root, dir, fixture := exportFixture(t)
	result, err := replayStages(t, fixture, filepath.Join(dir, "state.sqlite3"), 4, "virtual")
	if err != nil {
		t.Fatal(err)
	}
	verifyResult(t, root, dir, result, true)
	fresh := result.Phases[7]
	if fresh.FirstRecipientProgressMs != (Distribution{10, 20, 20, 20}) || fresh.MaximumRecipientLead != 1 || fresh.RecipientsWithProgress != 4 {
		t.Fatalf("unexpected fair first progress: %+v", fresh)
	}
	interrupted, resumed := result.Phases[10], result.Phases[11]
	if resumed.QueueAgeOffsetMs != interrupted.DrainMs+1000 {
		t.Fatalf("virtual recovery offset = %v", resumed.QueueAgeOffsetMs)
	}
	if resumed.ThroughputPerSecond != nil {
		t.Fatal("virtual throughput is not capacity evidence")
	}

	t.Run("oracle rejects wrong ordering", func(t *testing.T) {
		copy := result
		copy.Phases = append([]PhaseResult{}, result.Phases...)
		p := copy.Phases[6]
		p.DeliveriesByProfile = append([][]string{}, p.DeliveriesByProfile...)
		p.DeliveriesByProfile[0] = []string{"100004", "100000"}
		copy.Phases[6] = p
		verifyResult(t, root, dir, copy, false)
	})
	t.Run("oracle rejects wrong currency", func(t *testing.T) {
		copy := result
		copy.Phases = append([]PhaseResult{}, result.Phases...)
		p := copy.Phases[6]
		p.PayloadsByProfile = append([][]Listing{}, p.PayloadsByProfile...)
		p.PayloadsByProfile[1] = append([]Listing{}, p.PayloadsByProfile[1]...)
		p.PayloadsByProfile[1][0].Currency = "AMD"
		copy.Phases[6] = p
		verifyResult(t, root, dir, copy, false)
	})
	t.Run("existing state is refused", func(t *testing.T) {
		if _, err := Replay(fixture, filepath.Join(dir, "state.sqlite3"), 4, "virtual", "exercise"); err == nil {
			t.Fatal("overwrote state")
		}
	})
}
func TestReplayUsesSourceAndFilters(t *testing.T) {
	root, dir, fixture := exportFixture(t)
	file := filepath.Join(fixture, "updated-house.html")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.ReplaceAll(string(data), "500 USD", "501 USD"))
	if err = os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	result, err := replayStages(t, fixture, filepath.Join(dir, "state.sqlite3"), 4, "virtual")
	if err != nil && !strings.Contains(err.Error(), "retained history changed during resume") {
		t.Fatal(err)
	}
	if len(result.Phases[6].DeliveriesByProfile[1]) != 0 {
		t.Fatal("changed USD price still matched exact AMD filter")
	}
	verifyResult(t, root, dir, result, false)
}
func TestReplayRejectsUnknownCurrency(t *testing.T) {
	_, dir, fixture := exportFixture(t)
	file := filepath.Join(fixture, "seed-house.html")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, []byte(strings.ReplaceAll(string(data), "USD", "XYZ")), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Replay(fixture, filepath.Join(dir, "state.sqlite3"), 4, "virtual", "exercise"); err == nil || !strings.Contains(err.Error(), "missing exchange rate XYZ") {
		t.Fatalf("expected missing rate, got %v", err)
	}
}

func TestSharedRunnerFlushesCompleteResult(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "replay")
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	cmd := exec.Command("node", "experiments/node-replay/run.js", "--runtime", "go", "--go-binary", binary, "--users", "4", "--mode", "virtual")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if len(out) <= 65536 {
		t.Fatal("result must exercise pipe-buffer boundary")
	}
	var result Result
	if err = json.Unmarshal(out, &result); err != nil {
		t.Fatalf("truncated runner output: %v", err)
	}
	if result.Status != "passed" {
		t.Fatal("runner failed")
	}
}

func replayStages(t *testing.T, fixture, database string, users int, mode string) (Result, error) {
	t.Helper()
	run := func(stage string, want int) (Result, error) {
		cmd := exec.Command(os.Args[0], "-test.run=^TestReplayProcess$")
		cmd.Env = append(os.Environ(), "GO_REPLAY_CHILD="+stage, "GO_REPLAY_FIXTURE="+fixture, "GO_REPLAY_DB="+database, "GO_REPLAY_USERS="+strconv.Itoa(users), "GO_REPLAY_MODE="+mode)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		data, err := cmd.Output()
		code := 0
		if err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				code = exit.ExitCode()
			} else {
				return Result{}, err
			}
		}
		if code != want {
			return Result{}, fmt.Errorf("stage %s exit %d: %s", stage, code, stderr.String())
		}
		var result Result
		err = json.Unmarshal(data, &result)
		return result, err
	}
	exercise, err := run("exercise", 23)
	if err != nil {
		return exercise, err
	}
	resumed, err := run("resume", 0)
	resumed.Phases = append(exercise.Phases, resumed.Phases...)
	return resumed, err
}
func TestReplayProcess(t *testing.T) {
	stage := os.Getenv("GO_REPLAY_CHILD")
	if stage == "" {
		return
	}
	users, _ := strconv.Atoi(os.Getenv("GO_REPLAY_USERS"))
	result, err := Replay(os.Getenv("GO_REPLAY_FIXTURE"), os.Getenv("GO_REPLAY_DB"), users, os.Getenv("GO_REPLAY_MODE"), stage)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = json.NewEncoder(os.Stdout).Encode(result); err != nil {
		os.Exit(1)
	}
	if stage == "exercise" {
		os.Exit(23)
	}
	os.Exit(0)
}
func TestResumeRequiresInterruptedState(t *testing.T) {
	_, dir, fixture := exportFixture(t)
	if _, err := Replay(fixture, filepath.Join(dir, "missing.sqlite3"), 4, "virtual", "resume"); err == nil {
		t.Fatal("resume accepted missing database")
	}
}

// A transport acceptance cannot atomically commit the local SQLite acknowledgement.
func TestAcceptedBeforeAckMayDuplicateAfterCrash(t *testing.T) {
	if stage := os.Getenv("GO_ACK_WINDOW"); stage != "" {
		s, err := openStore(os.Getenv("GO_REPLAY_DB"))
		if err != nil {
			t.Fatal(err)
		}
		if stage == "accept" {
			l := Listing{ID: "1", Title: "accepted rental"}
			if _, err = s.crawl([]Listing{l}); err != nil {
				t.Fatal(err)
			}
			if _, err = s.db.Exec("INSERT INTO decisions VALUES(0,1,0,1,0)"); err != nil {
				t.Fatal(err)
			}
		}
		l, err := s.next(0)
		if err != nil || l == nil {
			t.Fatalf("pending: %v %v", l, err)
		}
		log, err := os.OpenFile(os.Getenv("GO_REPLAY_ACCEPTED"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = fmt.Fprintln(log, l.ID); err != nil {
			t.Fatal(err)
		}
		if err = log.Sync(); err != nil {
			t.Fatal(err)
		}
		log.Close()
		if stage == "accept" {
			os.Exit(23)
		}
		if err = s.acknowledge(0, l.ID, 1); err != nil {
			t.Fatal(err)
		}
		l, err = s.next(0)
		if err != nil || l != nil {
			t.Fatalf("ack not durable: %v %v", l, err)
		}
		s.db.Close()
		os.Exit(0)
	}
	dir := t.TempDir()
	accepted := filepath.Join(dir, "accepted.txt")
	for _, stage := range []string{"accept", "resume"} {
		cmd := exec.Command(os.Args[0], "-test.run=^TestAcceptedBeforeAckMayDuplicateAfterCrash$")
		cmd.Env = append(os.Environ(), "GO_ACK_WINDOW="+stage, "GO_REPLAY_DB="+filepath.Join(dir, "state.sqlite3"), "GO_REPLAY_ACCEPTED="+accepted)
		out, err := cmd.CombinedOutput()
		if stage == "accept" {
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.ExitCode() != 23 {
				t.Fatalf("crash: %v %s", err, out)
			}
		} else if err != nil {
			t.Fatalf("resume: %v %s", err, out)
		}
	}
	data, err := os.ReadFile(accepted)
	if err != nil || string(data) != "1\n1\n" {
		t.Fatalf("expected allowed duplicate: %q %v", data, err)
	}
}
