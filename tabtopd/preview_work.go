package main

// Preview work has one admission policy: wait at most five seconds, then
// return the format's busy error. Reads/rendering get two slots per format;
// EPUB rewriting gets one. Format-specific size/time limits remain separate.
import "time"

const (
	previewReadConcurrency = 2
	previewEditConcurrency = 1
	previewQueueWait       = 5 * time.Second
)

type previewWork struct{ slots chan struct{} }

func newPreviewWork(limit int) *previewWork { return &previewWork{make(chan struct{}, limit)} }
func (work *previewWork) acquire() (func(), bool) {
	timer := time.NewTimer(previewQueueWait)
	defer timer.Stop()
	select {
	case work.slots <- struct{}{}:
		return func() { <-work.slots }, true
	case <-timer.C:
		return nil, false
	}
}
