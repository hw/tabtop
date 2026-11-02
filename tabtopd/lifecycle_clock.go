package main

import "time"

// lifecycleClock is a local seam for expiry and retention policies. Its zero
// value uses real time; tests can advance time without waiting for deadlines.
type lifecycleClock struct {
	now       func() time.Time
	afterFunc func(time.Duration, func()) lifecycleTimer
}

type lifecycleTimer interface{ Stop() bool }

func (c lifecycleClock) Now() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func (c lifecycleClock) AfterFunc(d time.Duration, f func()) lifecycleTimer {
	if c.afterFunc != nil {
		return c.afterFunc(d, f)
	}
	return time.AfterFunc(d, f)
}
