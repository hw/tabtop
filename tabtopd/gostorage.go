// The remote browser's sites' localStorage, kept for the account (see
// docs/browser-plan.md, "Site storage kept"): as cookies are (gocookies.go),
// sealed in a file (-go-storage-file, with -go-cookies-key-file), so a
// site's pages find what they kept in it in a later tab, and after a
// restart. A tab's engine says each change its pages make (DOMStorage
// events), taken in as it's made; a page the tab goes to is given its
// origin's kept items before its own scripts run (a script put in its
// document as it's created), using paused document
// requests. Third-party frames keep their engine-local partition. sessionStorage isn't kept: a browser's ends with its tab.
//
// Site controls (go/sites) has each site's use, and clears a site's, or
// what was changed in a time, as it does its cookies; only sizes and
// counts go there, never what's kept, nor to the log.

package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	maxGoStorageSite = 5 << 20  // a site's keys and values, as browsers allow
	maxGoStorage     = 50 << 20 // all sites combined
	goStorageSealAD  = "tabtop go storage v1"
)

// goStorageOrigin is an origin's kept items, and when they last changed.
type goStorageOrigin struct {
	Items   map[string]string `json:"items"`
	Used    int64             `json:"used,omitempty"`
	Changed int64             `json:"changed"` // unix ms
	size    int64
}

func (o *goStorageOrigin) sum() {
	o.size = 0
	for k, v := range o.Items {
		o.size += int64(len(k) + len(v))
	}
}

// goStorage is the account's kept localStorage, by origin.
type goStorage struct {
	mu       sync.Mutex
	origins  map[string]*goStorageOrigin
	file     string // "" for in memory only
	key      []byte
	saving   *time.Timer
	writeMu  sync.Mutex
	forgetMu sync.Mutex
	clearing map[string]bool
	clearAll bool
	now      func() time.Time
}

func newGoStorage(file string, key []byte) *goStorage {
	s := &goStorage{origins: map[string]*goStorageOrigin{}, file: file, key: key, now: time.Now}
	if file == "" || key == nil {
		s.file = ""
		return s
	}
	data, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return s
	}
	var kept map[string]*goStorageOrigin
	if err == nil {
		var plain []byte
		if plain, err = goOpenSealed(key, goStorageSealAD, data); err == nil {
			if json.Unmarshal(plain, &kept) != nil {
				err = errors.New("invalid storage data")
			}
		}
	}
	if err != nil {
		if aside, aerr := setAside(file); aerr == nil {
			log.Printf("go: storage: %s couldn't be read (%v); set aside as %s", file, err, aside)
		} else {
			log.Printf("go: storage: %s couldn't be read (%v) nor set aside (%v); kept in memory only", file, err, aerr)
			s.file = ""
		}
		return s
	}
	for origin, o := range kept {
		if o == nil || goStorageOriginOf(origin) != origin || len(o.Items) == 0 {
			continue
		}
		o.sum()
		if o.size <= maxGoStorageSite {
			s.origins[origin] = o
		}
	}
	s.trimLocked()
	return s
}

func (s *goStorage) saveSoonLocked() {
	if s.file == "" || s.saving != nil {
		return
	}
	s.saving = time.AfterFunc(goCookieSaveDelay, s.save)
}

func (s *goStorage) flush() {
	if s.file != "" {
		s.save()
	}
}

func (s *goStorage) save() {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	if s.saving != nil {
		s.saving.Stop()
		s.saving = nil
	}
	plain, _ := json.Marshal(s.origins)
	data := goSeal(s.key, goStorageSealAD, plain)
	file := s.file
	s.mu.Unlock()
	if err := writeFileAtomic(file, data); err != nil {
		log.Printf("go: storage: saving: %v", err)
	}
}

// trimLocked evicts whole sites in order of oldest use.
func (s *goStorage) trimLocked() {
	type usage struct {
		origins []string
		bytes   int64
		used    int64
	}
	var total int64
	sites := map[string]*usage{}
	for origin, o := range s.origins {
		total += o.size
		site := goStorageSite(origin)
		u := sites[site]
		if u == nil {
			u = &usage{}
			sites[site] = u
		}
		u.origins = append(u.origins, origin)
		u.bytes += o.size
		u.used = max(u.used, o.lastUsed())
	}
	names := make([]string, 0, len(sites))
	for site, u := range sites {
		if u.bytes > maxGoStorageSite || total > maxGoStorage {
			names = append(names, site)
		}
	}
	slices.SortFunc(names, func(a, b string) int {
		return cmp.Or(cmp.Compare(sites[a].used, sites[b].used), cmp.Compare(a, b))
	})
	for _, site := range names {
		u := sites[site]
		if total <= maxGoStorage && u.bytes <= maxGoStorageSite {
			continue
		}
		total -= u.bytes
		for _, origin := range u.origins {
			delete(s.origins, origin)
		}
	}
}

func (o *goStorageOrigin) lastUsed() int64 { return max(o.Used, o.Changed) }

func goStorageSite(origin string) string { return goSite(strings.Trim(goOriginHost(origin), "[]")) }

// items is a copy of origin's kept items (nil: none).
func (s *goStorage) items(origin string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clearAll || s.clearing[goStorageSite(origin)] {
		return nil
	}
	o := s.origins[origin]
	if o == nil {
		return nil
	}
	o.Used = s.now().UnixMilli()
	s.saveSoonLocked()
	out := make(map[string]string, len(o.Items))
	for k, v := range o.Items {
		out[k] = v
	}
	return out
}

// set keeps origin's key as value (removed, value nil); an item that would
// take the origin past its limit isn't kept (the engine has its own, and
// says so to the page). Only a change is one: an item set to what's kept
// (as a page's given them) changes nothing, nor when.
func (s *goStorage) set(origin, key string, value *string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	site := goStorageSite(origin)
	if s.clearAll || s.clearing[site] {
		return
	}
	o := s.origins[origin]
	if value == nil {
		if o == nil {
			return
		}
		old, ok := o.Items[key]
		if !ok {
			return
		}
		delete(o.Items, key)
		o.size -= int64(len(key) + len(old))
		if len(o.Items) == 0 {
			s.dropOriginLocked(origin)
		}
	} else {
		if o == nil {
			o = &goStorageOrigin{Items: map[string]string{}}
		}
		old, had := o.Items[key]
		if had && old == *value {
			return
		}
		grow := int64(len(key) + len(*value))
		if had {
			grow -= int64(len(key) + len(old))
		}
		size := grow
		for other, data := range s.origins {
			if goStorageSite(other) == site {
				size += data.size
			}
		}
		if size > maxGoStorageSite {
			return
		}
		s.origins[origin] = o
		o.Items[key] = *value
		o.size += grow
	}
	o.Changed = s.now().UnixMilli()
	s.trimLocked()
	s.saveSoonLocked()
}

// clear forgets all of origin's (a page's localStorage.clear()).
func (s *goStorage) clear(origin string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.origins[origin] == nil {
		return
	}
	s.dropOriginLocked(origin)
	s.saveSoonLocked()
}

func (s *goStorage) dropOriginLocked(origin string) {
	delete(s.origins, origin)
	site, changed := goStorageSite(origin), s.now().UnixMilli()
	for other, o := range s.origins {
		if goStorageSite(other) == site {
			o.Changed = max(o.Changed, changed)
		}
	}
}

// forget clears the matching whole sites and suspends capture for them
// while the same data is cleared from the open engines.
func (s *goStorage) forget(site string, since time.Time, clearTabs func(map[string]bool)) {
	s.forgetMu.Lock()
	defer s.forgetMu.Unlock()
	s.mu.Lock()
	sites := map[string]bool{}
	for origin, o := range s.origins {
		if o.Changed >= since.UnixMilli() {
			sites[goStorageSite(origin)] = true
		}
	}
	if site != "" {
		sites = map[string]bool{site: true}
	}
	changed := false
	for origin := range s.origins {
		if !sites[goStorageSite(origin)] {
			continue
		}
		delete(s.origins, origin)
		changed = true
	}
	if changed {
		s.saveSoonLocked()
	}
	s.clearing = sites
	s.clearAll = site == "" && since.IsZero()
	s.mu.Unlock()
	clearTabs(sites)
	s.mu.Lock()
	s.clearing, s.clearAll = nil, false
	s.mu.Unlock()
}

// use is what's kept by site: bytes and items, and when last changed.
type goStorageUse struct {
	Bytes   int64
	Items   int
	Changed int64
}

func (s *goStorage) use() (map[string]goStorageUse, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]goStorageUse{}
	var total int64
	for origin, o := range s.origins {
		site := goStorageSite(origin)
		u := out[site]
		u.Bytes += o.size
		u.Items += len(o.Items)
		u.Changed = max(u.Changed, o.Changed)
		out[site] = u
		total += o.size
	}
	return out, total
}

// goStorageOriginOf matches location.origin, including default-port removal.
func goStorageOriginOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Hostname() == "" || u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	host, port := strings.ToLower(u.Hostname()), u.Port()
	if port != "" && !(u.Scheme == "http" && port == "80" || u.Scheme == "https" && port == "443") {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return u.Scheme + "://" + host
}

type goStorageDocument struct {
	script        string
	seed          map[string]string
	base          map[string]string
	ignoreThrough uint64
	skipFinalRead bool
}

type goStorageTab struct {
	mu        sync.Mutex
	root      string
	documents map[string]*goStorageDocument
	embedded  map[string]string // engine-local storage key to origin
}

// pageAt tells the engine's proxy its page is at raw, from now: what ad
// blocking holds its requests to (goadblock.go).
func (b *goBrowser) pageAt(raw string) {
	if b.e != nil {
		b.e.proxy.setPage(goPageHost(raw))
	}
}

// startStorage has Moli pause the tab's documents as they're asked for
// (Fetch, Document requests, storagePaused): the top frame's tells the
// proxy the page it's loading, before anything of it is fetched (pageAt);
// and, with site storage kept, what the document's origin kept is put
// back before its scripts run.
func (b *goBrowser) startStorage(ctx context.Context) {
	if b.e.adapter.name != "Moli" {
		return
	}
	var tree struct {
		FrameTree struct {
			Frame struct {
				ID string `json:"id"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if b.cdp.call(ctx, b.page, "Page.getFrameTree", nil, &tree) != nil || tree.FrameTree.Frame.ID == "" {
		return
	}
	storage := b.storage != nil && b.cdp.call(ctx, b.page, "DOMStorage.enable", nil, nil) == nil
	// Every request paused: documents here (storagePaused, in order with
	// the tab's other events); the page's other requests, for ad blocking
	// by their addresses, as they come (adPaused, goadblock.go).
	paused := b.adPaused
	b.cdp.paused.Store(&paused)
	if b.cdp.call(ctx, b.page, "Fetch.enable", map[string]any{
		"patterns": []map[string]string{{"urlPattern": "*", "requestStage": "Request"}},
	}, nil) != nil {
		b.cdp.paused.Store(nil)
		return
	}
	b.topFrame = tree.FrameTree.Frame.ID
	if !storage {
		return
	}
	b.storageTab.root = tree.FrameTree.Frame.ID
	b.storageTab.documents = map[string]*goStorageDocument{}
	b.storageTab.embedded = map[string]string{}
}

func goStorageRestore(origin string, items map[string]string) string {
	o, _ := json.Marshal(origin)
	d, _ := json.Marshal(items)
	// Parse the JSON as data so even "__proto__" is a regular storage key.
	payload, _ := json.Marshal(string(d))
	return `(() => { try { if (window !== window.top || location.origin !== ` + string(o) +
		`) return; const items = JSON.parse(` + string(payload) + `);
		for (const key of Object.keys(items)) if (localStorage.getItem(key) === null) localStorage.setItem(key, items[key]);
		} catch {} })();`
}

func (b *goBrowser) storagePaused(ev cdpEvent) {
	t := &b.storageTab
	var p struct {
		ID      string `json:"requestId"`
		Frame   string `json:"frameId"`
		Request struct {
			URL string `json:"url"`
		} `json:"request"`
	}
	if ev.SessionID != b.page || json.Unmarshal(ev.Params, &p) != nil || p.ID == "" {
		return
	}
	if b.cdp.interceptionDisabled.Load() {
		// Paused before interception was turned off, and come since: let
		// go, as it is, or the page's load waits on it for good.
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		b.cdp.call(ctx, b.page, "Fetch.continueRequest", map[string]string{"requestId": p.ID}, nil)
		return
	}
	if p.Frame == b.topFrame {
		b.pageAt(p.Request.URL)
		b.newAdPage()
	} else if b.adRefused(p.ID, p.Request.URL, goAdTSubdocument) {
		return // an embedded page that's an ad's
	}
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	if t.root != "" && p.Frame == t.root {
		b.prepareStorage(ctx, goStorageOriginOf(p.Request.URL))
	}
	cancel()
	ctx, cancel = context.WithTimeout(context.Background(), goCallTimeout)
	defer cancel()
	err := b.cdp.call(ctx, b.page, "Fetch.continueRequest", map[string]string{"requestId": p.ID}, nil)
	if err == nil {
		return
	}
	if cdpRequestGone(err) {
		// Stop, or another navigation taking over, canceled the request.
		return
	}
	b.cdp.disableInterception(b.page, "could not resume a document request: "+err.Error())
}

func (b *goBrowser) prepareStorage(ctx context.Context, origin string) {
	t := &b.storageTab
	t.mu.Lock()
	defer t.mu.Unlock()
	if origin == "" {
		return
	}
	// Redirects can abandon a script before it was used.
	for other, doc := range t.documents {
		if other != origin && doc.script != "" {
			b.removeStorageScript(ctx, doc)
			delete(t.documents, other)
		}
	}
	if t.documents[origin] != nil {
		return
	}
	doc := &goStorageDocument{base: map[string]string{}, seed: b.storage.items(origin)}
	t.documents[origin] = doc
	if len(doc.seed) == 0 {
		return
	}
	var r struct {
		Identifier string `json:"identifier"`
	}
	if b.cdp.call(ctx, b.page, "Page.addScriptToEvaluateOnNewDocument", map[string]string{
		"source": goStorageRestore(origin, doc.seed), "worldName": "tabtop-site-storage",
	}, &r) == nil {
		doc.script = r.Identifier
	} else {
		doc.seed = nil
	}
}

func (b *goBrowser) removeStorageScript(ctx context.Context, doc *goStorageDocument) {
	if doc.script != "" && b.cdp.call(ctx, b.page, "Page.removeScriptToEvaluateOnNewDocument",
		map[string]string{"identifier": doc.script}, nil) == nil {
		doc.script = ""
	}
}

func (b *goBrowser) storageShown(rawURL string) {
	t := &b.storageTab
	if t.root == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	origin := goStorageOriginOf(rawURL)
	doc := t.documents[origin]
	if doc == nil && origin != "" && b.cdp.interceptionDisabled.Load() {
		// Even without document-start restoration, collect what the site changes.
		t.documents[origin] = &goStorageDocument{base: map[string]string{}}
	}
	if doc != nil {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		b.removeStorageScript(ctx, doc)
	}
}

func (b *goBrowser) storageEvent(ev cdpEvent) {
	t := &b.storageTab
	if t.root == "" || ev.SessionID != b.page {
		return
	}
	var p struct {
		StorageID struct {
			SecurityOrigin string `json:"securityOrigin"`
			IsLocalStorage bool   `json:"isLocalStorage"`
			StorageKey     string `json:"storageKey"`
		} `json:"storageId"`
		Key      string  `json:"key"`
		NewValue *string `json:"newValue"`
	}
	if json.Unmarshal(ev.Params, &p) != nil || !p.StorageID.IsLocalStorage {
		return
	}
	origin := goStorageOriginOf(p.StorageID.SecurityOrigin)
	u, err := url.Parse(origin)
	if origin == "" || err != nil || p.StorageID.StorageKey == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	doc := t.documents[origin]
	if doc == nil || p.StorageID.StorageKey != goStorageKey(u) {
		// Keep the engine's exact partition for clearing. Only the normal
		// top-level partition participates in persistence.
		if ev.Method == "DOMStorage.domStorageItemAdded" || ev.Method == "DOMStorage.domStorageItemUpdated" {
			t.embedded[p.StorageID.StorageKey] = origin
		}
		return
	}
	if ev.Seq <= doc.ignoreThrough {
		return
	}
	switch ev.Method {
	case "DOMStorage.domStorageItemAdded", "DOMStorage.domStorageItemUpdated":
		if p.NewValue == nil {
			return
		}
		seed, seeded := doc.seed[p.Key]
		delete(doc.seed, p.Key)
		doc.base[p.Key] = *p.NewValue
		if !seeded || seed != *p.NewValue || ev.Method != "DOMStorage.domStorageItemAdded" {
			b.storage.set(origin, p.Key, p.NewValue)
		}
	case "DOMStorage.domStorageItemRemoved":
		delete(doc.seed, p.Key)
		delete(doc.base, p.Key)
		b.storage.set(origin, p.Key, nil)
	case "DOMStorage.domStorageItemsCleared":
		clear(doc.seed)
		clear(doc.base)
		b.storage.clear(origin)
	}
}

func goStorageKey(u *url.URL) string {
	host := goSite(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return "storage-key:v1;origin=" + u.String() + ";top-level-site=" + u.Scheme + "://" + host
}

func goStorageID(origin string) map[string]any {
	u, _ := url.Parse(origin)
	return map[string]any{"securityOrigin": origin, "storageKey": goStorageKey(u), "isLocalStorage": true}
}

func (b *goBrowser) endStorage() {
	t := &b.storageTab
	if t.root == "" {
		return
	}
	// Apply events waiting when the tab closed, before comparing final reads.
	for n := len(b.cdp.Events); n > 0; n-- {
		b.storageEvent(<-b.cdp.Events)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	defer cancel()
	for origin, doc := range t.documents {
		if doc.skipFinalRead {
			continue
		}
		var r struct {
			Entries [][]string `json:"entries"`
		}
		if b.cdp.call(ctx, b.page, "DOMStorage.getDOMStorageItems", map[string]any{"storageId": goStorageID(origin)}, &r) != nil || r.Entries == nil {
			continue
		}
		for _, e := range r.Entries {
			if len(e) != 2 {
				continue
			}
			old, had := doc.base[e[0]]
			seed, seeded := doc.seed[e[0]]
			if (!had || old != e[1]) && (!seeded || seed != e[1]) {
				b.storage.set(origin, e[0], &e[1])
			}
			delete(doc.base, e[0])
		}
		for key := range doc.base {
			b.storage.set(origin, key, nil)
		}
	}
}

func (b *goBrowser) forgetStorage(ctx context.Context, site string, selected map[string]bool, all bool) {
	t := &b.storageTab
	t.mu.Lock()
	defer t.mu.Unlock()
	for key, origin := range t.embedded {
		name := goStorageSite(origin)
		if all || name == site || selected[name] {
			if b.cdp.call(ctx, b.page, "DOMStorage.clear", map[string]any{
				"storageId": map[string]any{"securityOrigin": origin, "storageKey": key, "isLocalStorage": true},
			}, nil) == nil {
				delete(t.embedded, key)
			}
		}
	}
	for origin, doc := range t.documents {
		name := goStorageSite(origin)
		if !all && name != site && !selected[name] {
			continue
		}
		b.removeStorageScript(ctx, doc)
		doc.skipFinalRead = b.cdp.call(ctx, b.page, "DOMStorage.clear",
			map[string]any{"storageId": goStorageID(origin)}, nil) != nil
		clear(doc.seed)
		clear(doc.base)
		doc.ignoreThrough = b.cdp.eventSeq.Load()
	}
}
