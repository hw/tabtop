package main

import (
	"slices"
	"testing"
	"time"
)

func TestDownloadNoticePolicy(t *testing.T) {
	now := time.Unix(100, 0)
	p := newDownloadNotices()
	emit := func(kind eventKind, cookie uint32, name string) {
		p.observe(directoryEvent{kind: kind, cookie: cookie, name: name}, now)
	}
	// Pair an ordinary rename, an upload replacement, and a browser download.
	for i, names := range [][2]string{{"old.txt", "renamed.txt"}, {uploadTempPrefix + "123.part", "upload.txt"}, {"report.pdf.crdownload", "report.pdf"}} {
		emit(eventMovedFrom, uint32(i), names[0])
		emit(eventMovedTo, uint32(i), names[1])
	}
	emit(eventMovedTo, 10, "moved.txt")
	emit(eventWritten, 0, "written.txt")
	emit(eventWritten, 0, ".hidden")
	emit(eventWritten, 0, "partial.tmp")
	emit(eventWritten|eventDirectory, 0, "folder")
	if names := p.due(now.Add(watchSettle - time.Nanosecond)); len(names) != 0 {
		t.Fatalf("early: %v", names)
	}
	// A later write resets only that file's settling time.
	now = now.Add(watchSettle / 2)
	emit(eventWritten, 0, "written.txt")
	ready := p.due(now.Add(watchSettle / 2))
	slices.Sort(ready)
	if !slices.Equal(ready, []string{"moved.txt", "report.pdf"}) {
		t.Fatalf("due: %v", ready)
	}
	for _, name := range ready {
		p.reported(name, now.Add(watchSettle/2))
	}
	ready = p.due(now.Add(watchSettle))
	if !slices.Equal(ready, []string{"written.txt"}) {
		t.Fatalf("reset settle: %v", ready)
	}
	p.reported("written.txt", now.Add(watchSettle))
	now = now.Add(2 * watchSettle)
	emit(eventWritten, 0, "written.txt")
	if ready = p.due(now.Add(watchSettle)); len(ready) != 0 {
		t.Fatalf("duplicate: %v", ready)
	}
	now = now.Add(watchQuiet)
	emit(eventWritten, 0, "written.txt")
	if ready = p.due(now.Add(watchSettle)); !slices.Equal(ready, []string{"written.txt"}) {
		t.Fatalf("quiet period over: %v", ready)
	}
}

func TestFolderChangesPolicy(t *testing.T) {
	start := time.Unix(100, 0)
	var p folderChanges
	e := directoryEvent{kind: eventChanged, name: "file.txt"}
	p.observe(directoryEvent{kind: eventChanged, name: uploadTempPrefix + "123.part"}, start)
	if !p.deadline.IsZero() {
		t.Fatal("temporary upload scheduled refresh")
	}
	p.observe(e, start)
	p.observe(e, start.Add(100*time.Millisecond))
	if p.due(start.Add(349 * time.Millisecond)) {
		t.Fatal("burst emitted too soon")
	}
	if !p.due(start.Add(350*time.Millisecond)) || p.due(start.Add(time.Second)) {
		t.Fatal("burst did not emit exactly once")
	}
	// Continuous writes cannot postpone the refresh past changesMax.
	p.observe(e, start)
	for elapsed := 100 * time.Millisecond; elapsed < changesMax; elapsed += 100 * time.Millisecond {
		p.observe(e, start.Add(elapsed))
	}
	if p.due(start.Add(changesMax-time.Nanosecond)) || !p.due(start.Add(changesMax)) {
		t.Fatal("maximum debounce deadline not respected")
	}
	if !p.observe(directoryEvent{kind: eventGone}, start) {
		t.Fatal("directory removal was not immediate")
	}
	p.observe(directoryEvent{kind: eventOverflow}, start)
	if !p.due(start.Add(changesSettle)) {
		t.Fatal("overflow must refresh the listing")
	}
}
