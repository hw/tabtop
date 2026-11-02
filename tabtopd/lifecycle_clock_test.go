package main

import (
	"sync"
	"time"
)

// manualClock runs due callbacks outside its lock, in deadline order. Advancing
// time also runs timers scheduled by callbacks before the target time.
type manualClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*manualTimer
}
type manualTimer struct {
	clock   *manualClock
	at      time.Time
	run     func()
	stopped bool
}

func newManualClock() *manualClock { return &manualClock{now: time.Now()} }
func (c *manualClock) lifecycle() lifecycleClock {
	return lifecycleClock{now: func() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }, afterFunc: func(d time.Duration, f func()) lifecycleTimer {
		c.mu.Lock()
		defer c.mu.Unlock()
		t := &manualTimer{clock: c, at: c.now.Add(d), run: f}
		c.timers = append(c.timers, t)
		return t
	}}
}
func (t *manualTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	active := !t.stopped
	t.stopped = true
	return active
}
func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	target := c.now.Add(d)
	for {
		var next *manualTimer
		for _, t := range c.timers {
			if !t.stopped && !t.at.After(target) && (next == nil || t.at.Before(next.at)) {
				next = t
			}
		}
		if next == nil {
			c.now = target
			c.mu.Unlock()
			return
		}
		next.stopped = true
		c.now = next.at
		c.mu.Unlock()
		next.run()
		c.mu.Lock()
	}
}
