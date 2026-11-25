package main

import (
	"math"
	"slices"
	"time"
)

// keyedSlots counts what's going on, in all and by key (an address, a
// link, a session): one is taken while both its limits allow, and given
// back when it ends. It has no lock of its own: its owner's lock guards it,
// with whatever else the owner checks as it's taken.
type keyedSlots struct {
	total int
	by    map[string]int
}

// noLimit is a keyedSlots limit that never refuses.
const noLimit = math.MaxInt

// take takes one for key, if fewer than most are taken in all and fewer
// than perKey for key; it reports whether it did.
func (k *keyedSlots) take(key string, most, perKey int) bool {
	if k.total >= most || k.by[key] >= perKey {
		return false
	}
	if k.by == nil {
		k.by = map[string]int{}
	}
	k.total++
	k.by[key]++
	return true
}

// give gives back one taken for key.
func (k *keyedSlots) give(key string) {
	k.total--
	if k.by[key]--; k.by[key] <= 0 {
		delete(k.by, key)
	}
}

// windowCounter counts events (failed logins, requests for links that
// don't exist) by key within a window of time: each owner says its window,
// and how many keys it keeps at most, as it asks. Its zero value is ready
// for use; like keyedSlots, its owner's lock guards it.
type windowCounter struct {
	events map[string][]time.Time
	swept  time.Time
}

// recent is key's events less than window before now: the older ones
// forgotten, and key with them if none are left.
func (w *windowCounter) recent(key string, now time.Time, window time.Duration) []time.Time {
	r := slices.DeleteFunc(w.events[key], func(t time.Time) bool { return now.Sub(t) >= window })
	if len(r) == 0 {
		delete(w.events, key)
	} else {
		w.events[key] = r
	}
	return r
}

// add counts an event of key's at now. A key not counted yet, once
// maxKeys are (0 for no bound), is made room for: by the keys with
// nothing within window forgotten, then, if that's not enough, the one
// whose last event is oldest.
func (w *windowCounter) add(key string, now time.Time, window time.Duration, maxKeys int) {
	if w.events == nil {
		w.events = map[string][]time.Time{}
	}
	if _, known := w.events[key]; !known && maxKeys > 0 && len(w.events) >= maxKeys {
		w.sweep(now, window, 0)
		if len(w.events) >= maxKeys {
			oldest := ""
			for k, ts := range w.events {
				if oldest == "" || ts[len(ts)-1].Before(w.events[oldest][len(w.events[oldest])-1]) {
					oldest = k
				}
			}
			delete(w.events, oldest)
		}
	}
	w.events[key] = append(w.events[key], now)
}

// sweep forgets the keys with nothing within window, if it hasn't done so
// in the last every (0: now, whenever it last did).
func (w *windowCounter) sweep(now time.Time, window, every time.Duration) {
	if every > 0 && now.Sub(w.swept) < every {
		return
	}
	w.swept = now
	for k, ts := range w.events {
		if len(ts) == 0 || now.Sub(ts[len(ts)-1]) >= window {
			delete(w.events, k)
		}
	}
}

// recent remembers what finished lately, by key: for keep, and the newest
// max at most (the oldest forgotten first). Its zero value is ready for
// use; its owner's lock guards it.
type recent[V any] struct {
	m map[string]recentItem[V]
}

type recentItem[V any] struct {
	v  V
	at time.Time
}

// add remembers v for key, as of now.
func (r *recent[V]) add(key string, v V, now time.Time, keep time.Duration, max int) {
	if r.m == nil {
		r.m = map[string]recentItem[V]{}
	}
	for k, it := range r.m {
		if now.Sub(it.at) >= keep {
			delete(r.m, k)
		}
	}
	for len(r.m) >= max {
		oldest := ""
		for k, it := range r.m {
			if oldest == "" || it.at.Before(r.m[oldest].at) {
				oldest = k
			}
		}
		delete(r.m, oldest)
	}
	r.m[key] = recentItem[V]{v, now}
}

// get is what's remembered for key, if it's less than keep old.
func (r *recent[V]) get(key string, now time.Time, keep time.Duration) (V, bool) {
	it, ok := r.m[key]
	if !ok || now.Sub(it.at) >= keep {
		var none V
		return none, false
	}
	return it.v, true
}
