package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
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
	result, err := Replay(fixture, filepath.Join(dir, "state.sqlite3"), 4, "virtual")
	if err != nil {
		t.Fatal(err)
	}
	verifyResult(t, root, dir, result, true)
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
		if _, err := Replay(fixture, filepath.Join(dir, "state.sqlite3"), 4, "virtual"); err == nil {
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
	result, err := Replay(fixture, filepath.Join(dir, "state.sqlite3"), 4, "virtual")
	if err != nil {
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
	if _, err := Replay(fixture, filepath.Join(dir, "state.sqlite3"), 4, "virtual"); err == nil || !strings.Contains(err.Error(), "missing exchange rate XYZ") {
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
