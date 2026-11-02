package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestAuthenticationConcurrentReservations(t *testing.T) {
	var a authentication
	var accepted atomic.Int32
	var work sync.WaitGroup
	for range maxFailures * 4 {
		work.Go(func() {
			if a.beginLogin("192.0.2.1") {
				accepted.Add(1)
			}
		})
	}
	work.Wait()
	if got := accepted.Load(); got != maxFailures {
		t.Fatalf("accepted %d concurrent attempts, want %d", got, maxFailures)
	}
	for range maxFailures {
		a.endLogin("192.0.2.1", "", false)
	}
	if !a.beginLogin("192.0.2.1") {
		t.Fatal("released reservations still block login")
	}
	a.endLogin("192.0.2.1", "browser", true)
	history := a.loginHistory("192.0.2.2", "other browser", true)
	if len(history) != 1 || history[0].OK {
		t.Fatalf("prior history: %+v", history)
	}
	history[0].IP = "changed"
	if got := a.loginHistory("", "", false); len(got) != 2 || got[0].IP != "192.0.2.2" || got[1].IP != "192.0.2.1" {
		t.Fatalf("history order or isolation: %+v", got)
	}
}
