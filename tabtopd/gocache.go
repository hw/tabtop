package main

// The remote browser's engines' shared HTTP cache (see docs/browser-plan.md,
// section 3): Moli's own (--http-cache-dir), in one directory on disk that
// every tab's engine uses, so a site's scripts and stylesheets fetched in
// one tab are on disk for the next, and survive the engine (and tabtopd).
// The engines write it themselves, from their sandboxes (bound writable at
// /cache): that is the price of it. An engine taken over by a page could
// change what's cached for another site, which a later tab would then run;
// and Moli's entries are by address alone, not partitioned by the site that
// asked, so a site can time another's resources to learn whether they were
// fetched before. WEB_GO_CACHE=0 (-go-cache=false) turns it off.
//
// Moli doesn't bound it; tabtopd does: at start-up, while tabs are open and
// as they close (at most once a minute), the entries used longest ago go,
// until it's within goCacheMax.

import (
	"context"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	goCacheMax   = 512 << 20   // the cache's bytes, kept to
	goCacheEvery = time.Minute // the least time between prunings
)

// goCacheDir is where the engines' shared cache is, made if it isn't
// (only TabTop's user may read it): in the user's cache directory, or ""
// if there's none to use.
func goCacheDir() string {
	base, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	dir := filepath.Join(base, "tabtop", "go-http-cache")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("remote browser: no shared cache: %v", err)
		return ""
	}
	os.Chmod(dir, 0o700)
	return dir
}

var goCachePruned struct {
	sync.Mutex
	at time.Time
}

// goPruneCacheSoon prunes dir, unless it was pruned less than goCacheEvery
// ago; in the background.
func goPruneCacheSoon(dir string) {
	if dir == "" {
		return
	}
	goCachePruned.Lock()
	if time.Since(goCachePruned.at) < goCacheEvery {
		goCachePruned.Unlock()
		return
	}
	goCachePruned.at = time.Now()
	goCachePruned.Unlock()
	go goPruneCache(dir, goCacheMax)
}

// goPruneCache removes the entries of dir (Moli's: a directory each, or
// any file) used longest ago, by their files' latest change, until what's
// left is within max bytes. An engine reading one as it goes gets a miss.
func goPruneCache(dir string, max int64) {
	type entry struct {
		path string
		size int64
		used time.Time
	}
	var entries []entry
	var total int64
	items, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, it := range items {
		e := entry{path: filepath.Join(dir, it.Name())}
		filepath.WalkDir(e.path, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if info, err := d.Info(); err == nil {
				if !d.IsDir() {
					e.size += info.Size()
				}
				if info.ModTime().After(e.used) {
					e.used = info.ModTime()
				}
			}
			return nil
		})
		entries = append(entries, e)
		total += e.size
	}
	if total <= max {
		return
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].used.Before(entries[j].used) })
	removed := 0
	for _, e := range entries {
		if total <= max {
			break
		}
		// Only what's in the cache: nothing named to lead out of it.
		if !strings.HasPrefix(e.path, dir+string(filepath.Separator)) {
			continue
		}
		if os.RemoveAll(e.path) == nil {
			total -= e.size
			removed++
		}
	}
	goDebugf("shared cache: %d entries removed, %d MiB kept", removed, total>>20)
}

// goClearCache empties the cache dir: every entry; an engine reading one
// as it goes gets a miss. How much went, in bytes.
func goClearCache(dir string) int64 {
	if dir == "" {
		return 0
	}
	var before int64
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, err := d.Info(); err == nil {
				before += info.Size()
			}
		}
		return nil
	})
	items, _ := os.ReadDir(dir)
	for _, it := range items {
		os.RemoveAll(filepath.Join(dir, it.Name())) // a link: the link, not what it leads to
	}
	return before
}

// routeGoCacheClear clears what the remote browser keeps of what sites
// sent (not their cookies or storage: go/cookie): the engines' shared HTTP
// cache, each open tab's engine's own, and what each tab fetched for its
// copy. A page is fetched again from its site next.
func (g *server) routeGoCacheClear(c *tunnelCall) {
	if !g.goOn {
		c.r.fail("The remote browser is off or unavailable.")
		return
	}
	freed := goClearCache(g.goConfig.cache)
	var tabs []*goBrowser
	if g.goCookies != nil {
		g.goCookies.mu.Lock()
		tabs = g.goCookies.tabList()
		g.goCookies.mu.Unlock()
	}
	for _, b := range tabs {
		b.clearCache()
	}
	log.Printf("go: cache cleared from %s (%d tabs, %d MiB on disk)", c.ip, len(tabs), freed>>20)
	c.r.finish(map[string]any{"freed": freed, "tabs": len(tabs)})
}

// clearCache forgets what the tab fetched for its copy, and has its engine
// forget what it keeps itself (Moli: in memory, alongside the shared one).
func (b *goBrowser) clearCache() {
	b.res.clear()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.cdp.call(ctx, b.page, "Network.clearBrowserCache", nil, nil); err != nil {
		goDebugf("clear the engine's cache: %v", err)
	}
}
