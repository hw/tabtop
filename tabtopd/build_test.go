package main

import (
	"testing"
	"time"
)

func TestTabtopBuildTime(t *testing.T) {
	was := buildTime
	t.Cleanup(func() { buildTime = was })

	buildTime = "2026-11-06T01:02:03Z"
	if got := tabtopBuildTime(); got != "2026-11-06T01:02:03Z" {
		t.Fatalf("ldflags stamp: %q", got)
	}

	buildTime = " 2026-11-06T01:02:03Z "
	if got := tabtopBuildTime(); got != "2026-11-06T01:02:03Z" {
		t.Fatalf("trimmed: %q", got)
	}

	buildTime = ""
	got := tabtopBuildTime()
	if got == "" {
		t.Fatal("expected a fallback build time")
	}
	if _, err := time.Parse(time.RFC3339, got); err != nil {
		t.Fatalf("fallback %q: %v", got, err)
	}
}
