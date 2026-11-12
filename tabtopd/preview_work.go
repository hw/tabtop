package main

// Work bounded across every session (previews, searches, external
// resources) has one admission policy: wait a while for a slot (five
// seconds, unless said otherwise), giving up if the page does, then return
// the work's busy error. Reads/rendering get two slots per format; EPUB
// rewriting gets one. Format-specific size/time limits remain separate.
import (
	"context"
	"time"
)

const (
	previewReadConcurrency = 2
	previewEditConcurrency = 1
	previewQueueWait       = 5 * time.Second
)

type previewWork struct {
	slots chan struct{}
	wait  time.Duration
}

func newPreviewWork(limit int) *previewWork { return newBoundedWork(limit, previewQueueWait) }

// newBoundedWork is work with limit slots, waited for at most wait.
func newBoundedWork(limit int, wait time.Duration) *previewWork {
	return &previewWork{slots: make(chan struct{}, limit), wait: wait}
}

func (work *previewWork) acquire() (func(), bool) { return work.acquireContext(context.Background()) }

// acquireContext is acquire, given up on if ctx is done while it waits (a
// request the page no longer wants shouldn't hold up the ones it does).
func (work *previewWork) acquireContext(ctx context.Context) (func(), bool) {
	timer := time.NewTimer(work.wait)
	defer timer.Stop()
	select {
	case work.slots <- struct{}{}:
		return func() { <-work.slots }, true
	case <-timer.C:
		return nil, false
	case <-ctx.Done():
		return nil, false
	}
}
