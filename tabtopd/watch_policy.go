package main

import (
	"strings"
	"time"
)

const (
	// How long a file must go unchanged before it's told of, so a burst
	// of writes, or a download's last steps, make one notice.
	watchSettle = 700 * time.Millisecond
	// How long after one notice of a file another isn't sent, and how long
	// a name the gateway moved in itself stays quiet.
	watchQuiet = 10 * time.Second
	// A change in a folder the files page shows is told of once nothing
	// more has changed for changesSettle, or changesMax after the first,
	// so a steady stream of changes still shows.
	changesSettle = 250 * time.Millisecond
	changesMax    = time.Second
)

// Endings of the files browsers and others download into before renaming
// them to the file's real name.
var partialExts = []string{".crdownload", ".part", ".partial", ".download", ".tmp"}

// partialName reports whether name is a file being downloaded or uploaded,
// or hidden: one not to tell of.
func partialName(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	lower := strings.ToLower(name)
	for _, ext := range partialExts {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

type directoryEvent struct {
	kind   eventKind
	cookie uint32
	name   string
}
type eventKind uint8

const (
	eventChanged eventKind = 1 << iota
	eventDirectory
	eventMovedFrom
	eventMovedTo
	eventWritten
	eventGone
	eventOverflow
)

// downloadNotices tracks rename pairs, settling writes and duplicate notices.
// Its caller supplies timestamps and validates files before marking them told.
type downloadNotices struct {
	from    map[uint32]string
	pending map[string]time.Time
	told    map[string]time.Time
}

func newDownloadNotices() *downloadNotices {
	return &downloadNotices{from: map[uint32]string{}, pending: map[string]time.Time{}, told: map[string]time.Time{}}
}
func (p *downloadNotices) observe(e directoryEvent, now time.Time) {
	if e.kind&eventOverflow != 0 {
		clear(p.from)
		return
	}
	if e.kind&eventDirectory != 0 || e.name == "" || partialName(e.name) && e.kind&eventMovedFrom == 0 {
		return
	}
	if e.kind&eventMovedFrom != 0 {
		if len(p.from) > 256 {
			clear(p.from)
		}
		p.from[e.cookie] = e.name
		return
	}
	if e.kind&eventMovedTo != 0 {
		old, paired := p.from[e.cookie]
		delete(p.from, e.cookie)
		if paired && (!partialName(old) || strings.HasPrefix(old, uploadTempPrefix)) {
			return
		}
	}
	if e.kind&(eventWritten|eventMovedTo) != 0 {
		p.pending[e.name] = now
	}
}
func (p *downloadNotices) due(now time.Time) []string {
	var names []string
	for name, at := range p.pending {
		if now.Sub(at) < watchSettle {
			continue
		}
		delete(p.pending, name)
		if at, ok := p.told[name]; ok && now.Sub(at) < watchQuiet {
			continue
		}
		names = append(names, name)
	}
	for name, at := range p.told {
		if now.Sub(at) > watchQuiet {
			delete(p.told, name)
		}
	}
	return names
}
func (p *downloadNotices) reported(name string, now time.Time) { p.told[name] = now }

// folderChanges debounces a burst but caps the wait for continuous writes.
type folderChanges struct{ first, deadline time.Time }

func (p *folderChanges) observe(e directoryEvent, now time.Time) (gone bool) {
	if e.kind&eventGone != 0 {
		return true
	}
	if e.kind&eventOverflow == 0 && (e.name == "" || strings.HasPrefix(e.name, uploadTempPrefix)) {
		return false
	}
	if p.first.IsZero() {
		p.first = now
	}
	p.deadline = now.Add(changesSettle)
	if max := p.first.Add(changesMax); max.Before(p.deadline) {
		p.deadline = max
	}
	return false
}
func (p *folderChanges) due(now time.Time) bool {
	if p.deadline.IsZero() || now.Before(p.deadline) {
		return false
	}
	p.first, p.deadline = time.Time{}, time.Time{}
	return true
}
