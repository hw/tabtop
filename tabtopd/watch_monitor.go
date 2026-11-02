package main

import (
	"os"
	"path/filepath"
	"time"
)

// Monitors own the event source until returning, including early exits when
// a folder disappears or delivery fails. No drain goroutine is needed.
func monitorDownloads(dir string, source *directoryEvents, stop <-chan struct{}, saved func(string, int64) bool) error {
	defer source.Close()
	policy := newDownloadNotices()
	tick := time.NewTicker(watchSettle / 2)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return nil
		case e, ok := <-source.events:
			if !ok {
				return source.Err()
			}
			if e.kind&eventGone != 0 {
				return nil
			}
			policy.observe(e, time.Now())
		case now := <-tick.C:
			for _, name := range policy.due(now) {
				st, err := os.Lstat(filepath.Join(dir, name))
				if err != nil || !st.Mode().IsRegular() {
					continue
				}
				policy.reported(name, now)
				if !saved(name, st.Size()) {
					return nil
				}
			}
		}
	}
}

func monitorChanges(source *directoryEvents, stop <-chan struct{}, changed func() bool) error {
	defer source.Close()
	var policy folderChanges
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		select {
		case <-stop:
			return nil
		case e, ok := <-source.events:
			if !ok {
				return source.Err()
			}
			now := time.Now()
			if policy.observe(e, now) {
				if !changed() {
					return nil
				}
				return errDirGone
			}
			if !policy.deadline.IsZero() {
				timer.Reset(max(0, policy.deadline.Sub(now)))
			}
		case now := <-timer.C:
			if policy.due(now) && !changed() {
				return nil
			}
		}
	}
}
