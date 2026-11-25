package main

import "time"

// goAsks are what the page waits on the person, or their browser, for (a
// read of the clipboard, a screen orientation lock, a pop-up): each by its
// key, of the generation and world that asked it and when. Those of
// another generation (a page gone) or asked longer than their wait ago are
// let go as more are asked or one is answered. Its zero value is ready for
// use; the tab's loop alone uses it.
type goAsks[K comparable, V any] struct {
	m map[K]goPending[V]
}

// goPending is an ask: whose (gen, world), when, and what (v).
type goPending[V any] struct {
	gen, world int
	at         time.Time
	v          V
}

// due lets go of the asks not of gen, or asked more than wait ago.
func (a *goAsks[K, V]) due(gen int, wait time.Duration) {
	for k, p := range a.m {
		if p.gen != gen || time.Since(p.at) > wait {
			delete(a.m, k)
		}
	}
}

// add asks v, by key, for gen's world, unless max are waiting already (of
// gen, within wait): it reports whether it did.
func (a *goAsks[K, V]) add(key K, gen, world int, v V, max int, wait time.Duration) bool {
	a.due(gen, wait)
	if len(a.m) >= max {
		return false
	}
	if a.m == nil {
		a.m = map[K]goPending[V]{}
	}
	a.m[key] = goPending[V]{gen: gen, world: world, at: time.Now(), v: v}
	return true
}

// take takes the ask key answers, if it's waiting (of gen, within wait).
func (a *goAsks[K, V]) take(key K, gen int, wait time.Duration) (goPending[V], bool) {
	a.due(gen, wait)
	p, ok := a.m[key]
	if ok {
		delete(a.m, key)
	}
	return p, ok
}

// clear lets them all go.
func (a *goAsks[K, V]) clear() { a.m = nil }
