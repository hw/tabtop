package main

// Cleaning up, from Share links: deleting what uploads and
// fetches leave in ~/Downloads that nobody will use. Uploads from the files
// page cut off and kept to carry on (see keepPartial), uploads through
// upload links in pieces not being sent (see share_chunks.go), and
// temporary files with nothing behind them: those a crash or a forced stop
// left, which otherwise wait for the next start (see removeStaleUploads),
// and those the gateway left saving its own files. Uploads and fetches
// going on are never touched, nor a temporary file changed in the last
// cleanupAge, which one just starting could own.

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

const (
	// A temporary file changed since then is left alone.
	cleanupAge = 5 * time.Minute
	// How long the search of ~/Downloads may take.
	cleanupBudget = 10 * time.Second
	// How long an upload in pieces through a link must have had no piece
	// for Clean up to take it as left.
	cleanupIdle = fileStall
)

// atomicTempName matches what writeFileAtomic leaves if it's stopped.
var atomicTempName = regexp.MustCompile(`^\.shares-[0-9]+$`)

// cleanupReport is what cleaning up deletes, or would.
type cleanupReport struct {
	Kept    int   `json:"kept"`    // uploads kept to carry on
	Temps   int   `json:"temps"`   // temporary files with nothing behind them
	Bytes   int64 `json:"bytes"`   // what they take
	Stopped bool  `json:"stopped"` // the search took too long, and stopped part way
}

// cleanup deletes what the top of this file says, or with dry, only
// counts it.
func (g *server) cleanup(dry bool) cleanupReport {
	var rep cleanupReport
	busy := map[string]bool{} // temporary files in use, by path in ~/Downloads

	// Uploads from the files page: those going on, and those kept.
	m := &g.transfers
	m.mu.Lock()
	for id := range m.active {
		busy["id:"+id] = true
	}
	var kept []string
	for id, p := range m.partials {
		rep.Kept++
		rep.Bytes += p.held
		busy[p.tmp] = true
		kept = append(kept, id)
	}
	var dropped []*partialUpload
	if !dry {
		for _, id := range kept {
			dropped = append(dropped, m.dropPartialLocked(id))
		}
	}
	m.mu.Unlock()
	for _, p := range dropped {
		m.removePartial(p)
	}

	// Uploads through links, in pieces.
	if g.shares != nil {
		ps := &g.shares.partials
		ps.mu.Lock()
		idle := map[string]*linkPartial{}
		now := g.shares.clock.Now()
		for k, p := range ps.m {
			busy[p.part.tmp] = true
			// Between pieces isn't left: one that had a piece lately is
			// still going, its next on the way.
			if !p.busy && now.Sub(p.last) >= cleanupIdle {
				rep.Kept++
				rep.Bytes += p.part.held
				idle[k] = p
			}
		}
		ps.mu.Unlock()
		if !dry {
			for k, p := range idle {
				g.dropLinkPartial(k, p)
			}
		}
	}

	// Fetches going on.
	if g.fetches != nil {
		g.fetches.mu.Lock()
		for _, j := range g.fetches.jobs {
			j.mu.Lock()
			if j.tmp != "" {
				busy[j.tmp] = true
			}
			j.mu.Unlock()
		}
		g.fetches.mu.Unlock()
	}

	// The rest of ~/Downloads.
	before := time.Now().Add(-cleanupAge)
	if root, err := openDirectoryRoot(g.downloadsDir); err == nil {
		var stop atomic.Bool
		timer := time.AfterFunc(cleanupBudget, func() { stop.Store(true) })
		n, bytes := cleanTemps(root, before, busy, dry, &stop)
		timer.Stop()
		root.Close()
		rep.Temps += n
		rep.Bytes += bytes
		rep.Stopped = stop.Load()
	}

	// What saving the gateway's own files left.
	dirs := map[string]bool{}
	for _, f := range []string{g.sharesFile, g.activityFile, g.shareKeyFile} {
		if f != "" {
			dirs[filepath.Dir(f)] = true
		}
	}
	for dir := range dirs {
		des, _ := os.ReadDir(dir)
		for _, de := range des {
			info, err := de.Info()
			if err != nil || !de.Type().IsRegular() || !atomicTempName.MatchString(de.Name()) || !info.ModTime().Before(before) {
				continue
			}
			if dry || os.Remove(filepath.Join(dir, de.Name())) == nil {
				rep.Temps++
				rep.Bytes += info.Size()
			}
		}
	}
	return rep
}

// cleanTemps deletes, or with dry counts, the temporary files of uploads
// in root (and folders a replacing one staged its file in) last changed
// before before and not in busy, as walkStaleUploads does, until stop.
func cleanTemps(root *os.Root, before time.Time, busy map[string]bool, dry bool, stop *atomic.Bool) (int, int64) {
	n, bytes := 0, int64(0)
	dirs := []string{"."}
	for len(dirs) > 0 && !stop.Load() {
		d := dirs[len(dirs)-1]
		dirs = dirs[:len(dirs)-1]
		f, err := openRootDirectory(root, d)
		if err != nil {
			continue
		}
		for !stop.Load() {
			des, err := f.ReadDir(256)
			for _, de := range des {
				p := path.Join(d, de.Name())
				var info fs.FileInfo
				switch {
				case de.IsDir() && uploadStageName.MatchString(de.Name()):
					if info, err = de.Info(); err == nil && info.ModTime().Before(before) && (dry || root.RemoveAll(p) == nil) {
						n++
					}
				case de.IsDir():
					dirs = append(dirs, p)
				case de.Type().IsRegular() && uploadTempName.MatchString(de.Name()):
					id := strings.TrimSuffix(strings.TrimPrefix(de.Name(), uploadTempPrefix), ".part")
					if busy[p] || busy["id:"+id] {
						continue
					}
					if info, err = de.Info(); err == nil && info.ModTime().Before(before) && (dry || root.Remove(p) == nil) {
						n++
						bytes += info.Size()
					}
				}
			}
			if err != nil {
				break
			}
		}
		f.Close()
	}
	return n, bytes
}
