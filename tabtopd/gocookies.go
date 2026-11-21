// The remote browser's cookies, kept: each tab's engine starts with no
// profile, so what a site set (a login) was gone with the tab. The jar
// keeps them for the account, sealed in a file (-go-cookies-file, with
// -go-cookies-key-file); a new tab's engine is given them before it loads
// anything, and what each tab's sites set or remove since is taken back.
//
// Each tab is read for what changed since it was last read (a delta from
// its own last read, never its whole state): one tab still holding a
// cookie cleared in another (or from the settings) doesn't put it back.
// When each cookie was set or changed is the jar's own (CDP doesn't say),
// for clearing what was set in the last hour, day, and so on.
//
// Session cookies (no expiry) are kept in memory only, as a browser keeps
// them till it's closed: this server's run. Their values never go to the
// client: the settings get sites and counts.
//
// Moli's top-level localStorage is kept by gostorage.go. IndexedDB and
// other engine-local data are cleared in open tabs by this settings route.

package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/net/publicsuffix"
)

const (
	maxGoCookies      = 3000    // in the jar; the least lately changed go first
	maxGoCookieBytes  = 2 << 20 // all names and values together
	maxGoCookieValue  = 4096    // a cookie's name and value, as browsers limit them
	goCookieSaveDelay = 2 * time.Second
	goCookiesEvery    = 15 * time.Second // how often an open tab's are read
	goCookieSealAD    = "tabtop go cookies v1"
	// What's cleared of a site's storage: all but its cookies, which are
	// the jar's to remove (one by one: those set before a time cleared
	// stay).
	goSiteStorage = "local_storage,indexeddb,cache_storage,service_workers,file_systems,websql,shared_storage,storage_buckets"
)

// goCookie is a cookie as CDP has it (Network.Cookie), with when the jar
// first saw it, or saw its value change.
type goCookie struct {
	Name     string  `json:"name"`
	Value    string  `json:"value"`
	Domain   string  `json:"domain"` // ".example.com" for a domain cookie, the host for a host-only one
	Path     string  `json:"path"`
	Expires  float64 `json:"expires"` // seconds since 1970; -1 for a session cookie
	HTTPOnly bool    `json:"httpOnly"`
	Secure   bool    `json:"secure"`
	SameSite string  `json:"sameSite,omitempty"`
	Session  bool    `json:"session"`
	Changed  int64   `json:"changed,omitempty"` // unix ms, the jar's
}

type goCookieKey struct{ name, domain, path string }

func (c *goCookie) key() goCookieKey { return goCookieKey{c.Name, c.Domain, c.Path} }

// same is whether a and b are the same cookie as a site set it (when the
// jar saw it aside).
func (c *goCookie) same(o *goCookie) bool {
	return c.Value == o.Value && c.Expires == o.Expires && c.HTTPOnly == o.HTTPOnly && c.Secure == o.Secure && c.SameSite == o.SameSite && c.Session == o.Session
}

func (c *goCookie) expired(now time.Time) bool {
	return !c.Session && c.Expires > 0 && c.Expires < float64(now.Unix())
}

// host is the cookie's host, its domain without the dot.
func (c *goCookie) host() string { return strings.TrimPrefix(c.Domain, ".") }

// goSite is the site a host is of: its registrable domain (example.co.uk
// for www.example.co.uk), or the host itself (an address, localhost).
func goSite(host string) string {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if net.ParseIP(strings.Trim(host, "[]")) != nil {
		return host
	}
	if site, err := publicsuffix.EffectiveTLDPlusOne(host); err == nil {
		return site
	}
	return host
}

// importParams is the cookie for Network.setCookies: by a URL of its host
// and path, its domain only if it's a domain cookie (so a host-only one
// stays host-only, not sent to the host's subdomains).
func (c *goCookie) importParams() map[string]any {
	scheme := "http://"
	if c.Secure {
		scheme = "https://"
	}
	p := map[string]any{"name": c.Name, "value": c.Value, "url": scheme + c.host() + c.Path, "path": c.Path,
		"httpOnly": c.HTTPOnly, "secure": c.Secure}
	if strings.HasPrefix(c.Domain, ".") {
		p["domain"] = c.Domain
	}
	if !c.Session && c.Expires > 0 {
		p["expires"] = c.Expires
	}
	if c.SameSite != "" {
		p["sameSite"] = c.SameSite
	}
	return p
}

// goCookieJar is the account's cookies, and the tabs open, to clear theirs
// as the jar's are cleared.
type goCookieJar struct {
	mu      sync.Mutex
	cookies map[goCookieKey]*goCookie
	tabs    map[*goBrowser]struct{}
	file    string // "" for in memory only
	key     []byte
	saving  *time.Timer
	now     func() time.Time
}

// newGoCookieJar is the jar kept in file (sealed with the key in keyFile),
// or in memory if file is "".
func newGoCookieJar(file, keyFile string) *goCookieJar {
	j := &goCookieJar{cookies: map[goCookieKey]*goCookie{}, tabs: map[*goBrowser]struct{}{}, file: file, now: time.Now}
	if file == "" {
		return j
	}
	if keyFile == "" {
		log.Printf("go: cookies: no key file (-go-cookies-key-file): kept in memory only")
		j.file = ""
		return j
	}
	j.key = loadKeyFile(keyFile, "go: cookies")
	j.load()
	return j
}

// loadKeyFile reads a key from file, making one there if there's none; one
// that isn't a key is set aside, not overwritten.
func loadKeyFile(file, what string) []byte {
	key, err := os.ReadFile(file)
	if err == nil && len(key) == chacha20poly1305.KeySize {
		return key
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Printf("%s: reading the key: %v; one in memory till it can be read", what, err)
		return newShareKey()
	}
	if err == nil {
		if aside, aerr := setAside(file); aerr != nil {
			log.Printf("%s: the key file isn't a key, and can't be set aside (%v)", what, aerr)
			return newShareKey()
		} else {
			log.Printf("%s: the key file isn't a key; set aside as %s", what, aside)
		}
	}
	key = newShareKey()
	if err := writeFileAtomic(file, key); err != nil {
		log.Printf("%s: saving the key: %v; kept in memory only", what, err)
	}
	return key
}

func (j *goCookieJar) load() {
	data, err := os.ReadFile(j.file)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	var list []goCookie
	if err == nil {
		var plain []byte
		plain, err = j.open(data)
		if err == nil {
			err = json.Unmarshal(plain, &list)
		}
	}
	if err != nil {
		// Not overwritten: set aside, as the share links' file is.
		if aside, aerr := setAside(j.file); aerr == nil {
			log.Printf("go: cookies: %s couldn't be read (%v); set aside as %s, and a new jar begun", j.file, err, aside)
		} else {
			log.Printf("go: cookies: %s couldn't be read (%v) nor set aside (%v); kept in memory only", j.file, err, aerr)
			j.file = ""
		}
		return
	}
	now := j.now()
	for i := range list {
		c := list[i]
		if c.Session || c.expired(now) || len(c.Name)+len(c.Value) > maxGoCookieValue || c.Domain == "" {
			continue
		}
		j.cookies[c.key()] = &c
	}
	j.trimLocked()
}

func (j *goCookieJar) seal(plain []byte) []byte { return goSeal(j.key, goCookieSealAD, plain) }

func (j *goCookieJar) open(data []byte) ([]byte, error) {
	return goOpenSealed(j.key, goCookieSealAD, data)
}

// goSeal seals plain with key (XChaCha20-Poly1305, a random nonce first),
// for what (ad: what it is, so one kind's can't pass for another's).
func goSeal(key []byte, ad string, plain []byte) []byte {
	aead, _ := chacha20poly1305.NewX(key)
	nonce := make([]byte, aead.NonceSize())
	rand.Read(nonce)
	return aead.Seal(nonce, nonce, plain, []byte(ad))
}

// goOpenSealed is what goSeal sealed.
func goOpenSealed(key []byte, ad string, data []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	if len(data) < aead.NonceSize() {
		return nil, errors.New("too short")
	}
	return aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], []byte(ad))
}

// saveSoon writes the jar a moment later (changes come in runs).
func (j *goCookieJar) saveSoonLocked() {
	if j.file == "" || j.saving != nil {
		return
	}
	j.saving = time.AfterFunc(goCookieSaveDelay, j.save)
}

func (j *goCookieJar) save() {
	j.mu.Lock()
	j.saving = nil
	now := j.now()
	list := make([]goCookie, 0, len(j.cookies))
	for _, c := range j.cookies {
		if !c.Session && !c.expired(now) {
			list = append(list, *c)
		}
	}
	plain, _ := json.Marshal(list)
	data := j.seal(plain)
	file := j.file
	j.mu.Unlock()
	if err := writeFileAtomic(file, data); err != nil {
		log.Printf("go: cookies: saving: %v", err)
	}
}

// trimLocked keeps the jar within its count and size: the least lately
// changed go first (a page can set cookies without end).
func (j *goCookieJar) trimLocked() {
	bytes := 0
	for _, c := range j.cookies {
		bytes += len(c.Name) + len(c.Value)
	}
	if len(j.cookies) <= maxGoCookies && bytes <= maxGoCookieBytes {
		return
	}
	all := make([]*goCookie, 0, len(j.cookies))
	for _, c := range j.cookies {
		all = append(all, c)
	}
	slices.SortFunc(all, func(a, b *goCookie) int { return int(min(max(a.Changed-b.Changed, -1), 1)) })
	for _, c := range all {
		if len(j.cookies) <= maxGoCookies && bytes <= maxGoCookieBytes {
			break
		}
		delete(j.cookies, c.key())
		bytes -= len(c.Name) + len(c.Value)
	}
}

// forImport is the jar's cookies (but those expired), for a new engine.
func (j *goCookieJar) forImport() []map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	now := j.now()
	out := make([]map[string]any, 0, len(j.cookies))
	for _, c := range j.cookies {
		if !c.expired(now) {
			out = append(out, c.importParams())
		}
	}
	return out
}

// lookup is the jar's cookie of key, if any (a copy).
func (j *goCookieJar) lookup(k goCookieKey) (goCookie, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	c, ok := j.cookies[k]
	if !ok {
		return goCookie{}, false
	}
	return *c, true
}

// apply takes what changed in a tab since it was read last (prev): what
// it has that's new or changed is kept, what it no longer has is removed,
// if it's in the jar as that tab last had it (not since set by another).
func (j *goCookieJar) apply(prev, now map[goCookieKey]goCookie) (changed int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	t := j.now()
	for k, c := range now {
		if p, ok := prev[k]; ok && p.same(&c) {
			continue
		}
		if len(c.Name)+len(c.Value) > maxGoCookieValue || c.expired(t) {
			continue
		}
		c := c
		if had, ok := j.cookies[k]; ok && had.Value == c.Value {
			c.Changed = had.Changed // its expiry renewed, say: not set anew
		} else {
			c.Changed = t.UnixMilli()
		}
		j.cookies[k] = &c
		changed++
	}
	for k, p := range prev {
		if _, ok := now[k]; ok {
			continue
		}
		if had, ok := j.cookies[k]; ok && had.Value == p.Value {
			delete(j.cookies, k)
			changed++
		}
	}
	if changed > 0 {
		j.trimLocked()
		j.saveSoonLocked()
	}
	return changed
}

// goForgetWithin is the times that can be cleared (seconds; 0 for all):
// the last hour, day, week, month (30 days) and six months (182).
var goForgetWithin = []int64{0, 3600, 86400, 7 * 86400, 30 * 86400, 182 * 86400}

// routeGoCookies lists the sites with cookies kept, or data in a tab
// open: their names and counts, never their cookies' values.
func (g *server) routeGoCookies(c *tunnelCall) {
	if !g.goOn || g.goCookies == nil {
		c.r.fail("The remote browser is off or unavailable, so it keeps no cookies.")
		return
	}
	c.r.finish(g.goCookiesReport(nil))
}

// routeGoCookiesForget deletes a site's cookies and data (Name), or (Name
// "") what was set in the last Within seconds (0: all).
func (g *server) routeGoCookiesForget(c *tunnelCall) {
	if !g.goOn || g.goCookies == nil {
		c.r.fail("The remote browser is off or unavailable, so it keeps no cookies.")
		return
	}
	site, within := strings.ToLower(strings.TrimSpace(c.req.Name)), c.req.Within
	if len(site) > 253 || site == "" && !slices.Contains(goForgetWithin, within) {
		c.r.fail("That isn't a site or a time to clear.")
		return
	}
	var since time.Time
	if site == "" && within > 0 {
		since = time.Now().Add(-time.Duration(within) * time.Second)
	}
	var n int
	if g.goStorage != nil {
		g.goStorage.forget(site, since, func(selected map[string]bool) {
			n = g.goCookies.forgetWithStorage(site, since, selected)
		})
	} else {
		n = g.goCookies.forget(site, since)
	}
	what := "a site's"
	if site == "" {
		what = "the last " + strconv.FormatInt(within, 10) + " s's"
		if within == 0 {
			what = "all"
		}
	}
	log.Printf("go: cookies: %s cleared from %s (%d)", what, c.ip, n)
	c.r.finish(g.goCookiesReport(map[string]any{"forgotten": n}))
}

// goCookiesReport is what the settings page is told of what sites keep:
// each site's cookies and storage, and the storage's use of its limit;
// with more, if given.
func (g *server) goCookiesReport(more map[string]any) map[string]any {
	r := map[string]any{"kept": g.goCookies.file != ""}
	var use map[string]goStorageUse
	if g.goStorage != nil {
		var used int64
		use, used = g.goStorage.use()
		r["storage"] = map[string]any{"used": used, "max": maxGoStorage, "kept": g.goStorage.file != ""}
	}
	r["sites"] = g.goCookies.sites(use)
	for k, v := range more {
		r[k] = v
	}
	return r
}

// goSiteInfo is a site in the settings: its cookies, how many and when
// last set, and whether a tab open has been there (its storage, there).
type goSiteInfo struct {
	Site    string `json:"site"`
	Cookies int    `json:"cookies"`
	Changed int64  `json:"changed,omitempty"` // unix ms
	Visited int64  `json:"visited,omitempty"` // latest visit in an open tab, unix ms
	Open    bool   `json:"open,omitempty"`
	// Its localStorage kept (gostorage.go): bytes and items.
	Storage      int64 `json:"storage,omitempty"`
	StorageItems int   `json:"storageItems,omitempty"`
}

// sites is the jar's sites, those whose storage is kept (store), and those
// the tabs open have been to.
func (j *goCookieJar) sites(use map[string]goStorageUse) []goSiteInfo {
	j.mu.Lock()
	by := map[string]*goSiteInfo{}
	now := j.now()
	for _, c := range j.cookies {
		if c.expired(now) {
			continue
		}
		s := goSite(c.host())
		info := by[s]
		if info == nil {
			info = &goSiteInfo{Site: s}
			by[s] = info
		}
		info.Cookies++
		info.Changed = max(info.Changed, c.Changed)
	}
	tabs := j.tabList()
	j.mu.Unlock()
	for site, u := range use {
		info := by[site]
		if info == nil {
			info = &goSiteInfo{Site: site}
			by[site] = info
		}
		info.Storage, info.StorageItems = u.Bytes, u.Items
		info.Changed = max(info.Changed, u.Changed)
	}
	for _, b := range tabs {
		for origin, visited := range b.visitedOrigins(time.Time{}) {
			s := goSite(goOriginHost(origin))
			if by[s] == nil {
				by[s] = &goSiteInfo{Site: s}
			}
			by[s].Open = true
			by[s].Visited = max(by[s].Visited, visited.UnixMilli())
		}
	}
	out := make([]goSiteInfo, 0, len(by))
	for _, info := range by {
		out = append(out, *info)
	}
	slices.SortFunc(out, func(a, b goSiteInfo) int { return strings.Compare(a.Site, b.Site) })
	return out
}

func (j *goCookieJar) tabList() []*goBrowser {
	out := make([]*goBrowser, 0, len(j.tabs))
	for b := range j.tabs {
		out = append(out, b)
	}
	return out
}

// forget removes the site's cookies (site "" with since: those set since
// then; since zero, all), and clears them, and the storage of the site (or
// of what was visited since), in the tabs open.
func (j *goCookieJar) forget(site string, since time.Time) int {
	return j.forgetWithStorage(site, since, nil)
}

func (j *goCookieJar) forgetWithStorage(site string, since time.Time, selected map[string]bool) int {
	j.mu.Lock()
	var gone []goCookie
	for k, c := range j.cookies {
		if site != "" && goSite(c.host()) != site || site == "" && c.Changed < since.UnixMilli() {
			continue
		}
		gone = append(gone, *c)
		delete(j.cookies, k)
	}
	if len(gone) > 0 {
		j.saveSoonLocked()
	}
	tabs := j.tabList()
	j.mu.Unlock()
	for _, b := range tabs {
		b.forgetCookies(gone, site, since, selected)
	}
	return len(gone)
}

func (j *goCookieJar) addTab(b *goBrowser) {
	j.mu.Lock()
	j.tabs[b] = struct{}{}
	j.mu.Unlock()
}

func (j *goCookieJar) dropTab(b *goBrowser) {
	j.mu.Lock()
	delete(j.tabs, b)
	j.mu.Unlock()
}

// goOriginHost is an origin's host ("https://www.example.com" ->
// "www.example.com").
func goOriginHost(origin string) string {
	host := origin[strings.Index(origin, "://")+3:]
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

// --- A tab's side --------------------------------------------------------

// goCookieTab is a tab's part: its engine's cookies as last read, and the
// sites it has been to (and when), for clearing their storage.
type goCookieTab struct {
	mu      sync.Mutex
	base    map[goCookieKey]goCookie
	started bool
	visits  map[string]time.Time // origin -> last there
	top     string               // the site of the page shown, for SameSite
	page    string               // the page shown, for Referer
}

// exportCookies reads the engine's cookies. An engine that doesn't say a
// domain cookie's dot (Obscura) has it taken as the jar has it, or else as
// host-only (sent to no more than its host).
func (b *goBrowser) exportCookies(ctx context.Context) (map[goCookieKey]goCookie, error) {
	var r struct {
		Cookies []goCookie `json:"cookies"`
	}
	if err := b.cdp.call(ctx, b.page, "Network.getAllCookies", nil, &r); err != nil {
		return nil, err
	}
	out := make(map[goCookieKey]goCookie, len(r.Cookies))
	for _, c := range r.Cookies {
		if c.Name == "" && c.Value == "" || c.Domain == "" {
			continue
		}
		c.Changed = 0
		if b.e != nil && b.e.adapter.cookieScopeLost && !strings.HasPrefix(c.Domain, ".") {
			if _, ok := b.jar.lookup(goCookieKey{c.Name, "." + c.Domain, c.Path}); ok {
				c.Domain = "." + c.Domain
			}
		}
		out[c.key()] = c
	}
	return out, nil
}

// startCookies gives the engine the jar's cookies, before it loads
// anything, and reads them back: what it kept is what's compared with
// next (a cookie it refused isn't taken as removed).
func (b *goBrowser) startCookies(ctx context.Context) {
	if b.jar == nil {
		return
	}
	b.cookies.mu.Lock()
	defer b.cookies.mu.Unlock()
	if list := b.jar.forImport(); len(list) > 0 {
		if err := b.cdp.call(ctx, b.page, "Network.setCookies", map[string]any{"cookies": list}, nil); err != nil {
			goDebugf("cookies: giving %d: %v", len(list), err)
		}
	}
	base, err := b.exportCookies(ctx)
	if err != nil {
		goDebugf("cookies: reading back: %v", err)
		return
	}
	b.cookies.base, b.cookies.started = base, true
	b.jar.addTab(b)
	goDebugf("cookies: %d given", len(base))
}

// syncCookies takes what the tab's sites set or removed since it was read.
func (b *goBrowser) syncCookies() {
	if b.jar == nil {
		return
	}
	b.cookies.mu.Lock()
	defer b.cookies.mu.Unlock()
	if !b.cookies.started {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	now, err := b.exportCookies(ctx)
	if err != nil {
		return
	}
	if n := b.jar.apply(b.cookies.base, now); n > 0 {
		goDebugf("cookies: %d changed", n)
	}
	b.cookies.base = now
}

// endCookies takes the tab's last changes, as it closes.
func (b *goBrowser) endCookies() {
	if b.jar == nil {
		return
	}
	b.syncCookies()
	b.jar.dropTab(b)
}

// visited notes that the tab showed a page of origin.
func (b *goBrowser) visited(rawURL string) {
	origin := goOrigin(rawURL)
	if origin == "" {
		return
	}
	b.cookies.mu.Lock()
	defer b.cookies.mu.Unlock()
	if b.cookies.visits == nil {
		b.cookies.visits = map[string]time.Time{}
	}
	if len(b.cookies.visits) < 1000 {
		b.cookies.visits[origin] = time.Now()
	}
	b.cookies.top = goSite(goOriginHost(origin))
	b.cookies.page = rawURL
	b.pageAt(rawURL)
}

// --- Who asks: the cookies and Referer a page's browser would send ---------

// goFrom is what a fetch for a page sends as the page's browser would: the
// cookies for an address, and its Referer, worked out for each address
// (the first, and each a redirect goes to). nil: neither.
type goFrom struct {
	cookies func(*url.URL) string
	referer func(*url.URL) string
	page    func() string     // the page's address, for ad blocking; nil: none known
	onAd    func(what string) // told what was refused as an ad's: a host, or an address
}

// adBlocked is whether a fetch of u for the page, of kind (image, css,
// font, media), is an ad's or a tracker's (goadblock.go): by its host, or
// its address. Nothing is, with no page to say whose.
func (f *goFrom) adBlocked(u *url.URL, kind string) bool {
	if f == nil || f.page == nil {
		return false
	}
	blocked, byHost := goAdBlockedURL(u.String(), goAdKindTypes[kind], goPageHost(f.page()))
	if !blocked {
		return false
	}
	if f.onAd != nil {
		if byHost {
			f.onAd(u.Hostname())
		} else {
			f.onAd(u.String())
		}
	}
	return true
}

// goPageHost is a page's address's host, "" if it has none.
func goPageHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func (f *goFrom) apply(r *http.Request) {
	r.Header.Del("Cookie")
	r.Header.Del("Referer")
	if f == nil {
		return
	}
	if f.cookies != nil {
		if c := f.cookies(r.URL); c != "" {
			r.Header.Set("Cookie", c)
		}
	}
	if f.referer != nil {
		if ref := f.referer(r.URL); ref != "" {
			r.Header.Set("Referer", ref)
		}
	}
}

// goReferrer is the Referer a page (page) sends with a request to u, as a
// browser's default policy has it (strict-origin-when-cross-origin): the
// page's address to its own origin, its origin to another, nothing from
// https to http. Never its fragment, nor a user and password.
func goReferrer(page string, u *url.URL) string {
	p, err := url.Parse(page)
	if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
		return ""
	}
	if p.Scheme == "https" && u.Scheme != "https" {
		return ""
	}
	p.User, p.Fragment, p.RawFragment = nil, "", ""
	if p.Scheme == u.Scheme && strings.EqualFold(p.Host, u.Host) {
		return p.String()
	}
	return p.Scheme + "://" + p.Host + "/"
}

// from is what the tab's fetches send: its sites' cookies (siteCookies), and
// the page shown as their Referer, if the settings say (on, at first).
func (b *goBrowser) from() *goFrom {
	f := &goFrom{cookies: b.siteCookies, onAd: b.adCounted, page: func() string {
		b.cookies.mu.Lock()
		defer b.cookies.mu.Unlock()
		return b.cookies.page
	}}
	if b.sites == nil || b.sites.sendReferer() {
		f.referer = func(u *url.URL) string {
			b.cookies.mu.Lock()
			page := b.cookies.page
			b.cookies.mu.Unlock()
			return goReferrer(page, u)
		}
	}
	return f
}

// fromNow is from, held to the page shown now, for a fetch that outlives
// it (a file saved from it: a video's Download, a link to a file): it says
// that page (Referer), and is sent the cookies that page's own requests
// are (SameSite as for its site), as playing the video was, whichever page
// the tab's gone on to by the time it asks again (a stall resumed, a
// redirect).
func (b *goBrowser) fromNow() *goFrom {
	b.cookies.mu.Lock()
	page, top := b.cookies.page, b.cookies.top
	b.cookies.mu.Unlock()
	f := &goFrom{cookies: func(u *url.URL) string { return b.siteCookiesAt(u, top) }, page: func() string { return page }}
	if b.sites == nil || b.sites.sendReferer() {
		f.referer = func(u *url.URL) string { return goReferrer(page, u) }
	}
	return f
}

// goFromNoTab is what's sent for a fetch with no tab to say whose page asks
// (a go-resource request on a tunnel of its own): the jar's cookies any
// page may send (SameSite=None), and no Referer (no page to say).
func (g *server) goFromNoTab() *goFrom {
	if g.goCookies == nil {
		return nil
	}
	return &goFrom{cookies: func(u *url.URL) string { return g.goCookies.header(u, "") }}
}

// --- Cookies sent with what the server fetches for a page -----------------

// goCookieHeaderMax is the most a Cookie header sent for media may be.
const goCookieHeaderMax = 8 << 10

// goSendable is whether c goes with a request to u from a page of site top
// ("": none known): over https if it's secure, not expired, and (SameSite)
// only to the page's own site unless it's None (a cross-site request, as a
// video's from another site's page; None requires Secure, as Chrome has it).
func goSendable(c *goCookie, u *url.URL, top string, now time.Time) bool {
	if c.expired(now) || c.Secure && u.Scheme != "https" {
		return false
	}
	if strings.EqualFold(c.SameSite, "None") {
		return c.Secure
	}
	return top != "" && goSite(u.Hostname()) == top
}

// goCookieHeader is cookies as a Cookie header: the longest paths first,
// as browsers send them, to at most goCookieHeaderMax.
func goCookieHeader(list []goCookie) string {
	slices.SortStableFunc(list, func(a, b goCookie) int { return len(b.Path) - len(a.Path) })
	var out strings.Builder
	for _, c := range list {
		pair := c.Name + "=" + c.Value
		if out.Len()+len(pair)+2 > goCookieHeaderMax {
			break
		}
		if out.Len() > 0 {
			out.WriteString("; ")
		}
		out.WriteString(pair)
	}
	return out.String()
}

// goCookieMatches is whether the cookie is for u's host and path.
func goCookieMatches(c *goCookie, u *url.URL) bool {
	host, d := strings.ToLower(u.Hostname()), strings.ToLower(c.host())
	if strings.HasPrefix(c.Domain, ".") {
		if host != d && !strings.HasSuffix(host, "."+d) {
			return false
		}
	} else if host != d {
		return false
	}
	p := u.EscapedPath()
	if p == "" {
		p = "/"
	}
	cp := c.Path
	if cp == "" {
		cp = "/"
	}
	return p == cp || strings.HasPrefix(p, cp) && (strings.HasSuffix(cp, "/") || p[len(cp)] == '/')
}

// header is the jar's cookies for u, from a page of site top, as a
// Cookie header.
func (j *goCookieJar) header(u *url.URL, top string) string {
	j.mu.Lock()
	now := j.now()
	var list []goCookie
	for _, c := range j.cookies {
		if goCookieMatches(c, u) && goSendable(c, u, top, now) {
			list = append(list, *c)
		}
	}
	j.mu.Unlock()
	return goCookieHeader(list)
}

// siteCookies is the Cookie header for what the tab's page asks of u (its
// media, pictures, fonts, stylesheets):
// the engine's cookies for it now (its sites' latest, httpOnly ones too),
// those a request from the page shown may carry; the jar's, if the engine
// can't say.
func (b *goBrowser) siteCookies(u *url.URL) string {
	b.cookies.mu.Lock()
	top := b.cookies.top
	b.cookies.mu.Unlock()
	return b.siteCookiesAt(u, top)
}

// siteCookiesAt is siteCookies for a page of the site top (SameSite's).
// The engine's cookies while the tab is open; the account's kept ones once
// it's gone.
func (b *goBrowser) siteCookiesAt(u *url.URL, top string) string {
	ctx, cancel := context.WithTimeout(b.ctx, 3*time.Second)
	defer cancel()
	var r struct {
		Cookies []goCookie `json:"cookies"`
	}
	if err := b.cdp.call(ctx, b.page, "Network.getCookies", map[string]any{"urls": []string{u.String()}}, &r); err != nil {
		if b.jar != nil {
			return b.jar.header(u, top)
		}
		return ""
	}
	now := time.Now()
	list := r.Cookies[:0]
	for _, c := range r.Cookies {
		if goSendable(&c, u, top, now) {
			list = append(list, c)
		}
	}
	return goCookieHeader(list)
}

func (b *goBrowser) visitedOrigins(since time.Time) map[string]time.Time {
	b.cookies.mu.Lock()
	defer b.cookies.mu.Unlock()
	out := map[string]time.Time{}
	for o, t := range b.cookies.visits {
		if !t.Before(since) {
			out[o] = t
		}
	}
	return out
}

// goOrigin is a URL's origin, "" if it isn't http(s).
func goOrigin(rawURL string) string {
	scheme, rest, ok := strings.Cut(rawURL, "://")
	if !ok || (scheme != "http" && scheme != "https") {
		return ""
	}
	host, _, _ := strings.Cut(rest, "/")
	host, _, _ = strings.Cut(host, "?")
	host, _, _ = strings.Cut(host, "#")
	if host == "" || strings.Contains(host, "@") {
		return ""
	}
	return scheme + "://" + strings.ToLower(host)
}

// forgetCookies removes cookies the jar forgot from the engine, and clears
// the storage of the site's origins (site), or of those visited since
// (site ""), that the tab has been to; then reads the engine again, so
// what it no longer has isn't taken as its doing.
func (b *goBrowser) forgetCookies(gone []goCookie, site string, since time.Time, selected map[string]bool) {
	b.cookies.mu.Lock()
	defer b.cookies.mu.Unlock()
	if !b.cookies.started {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	b.forgetStorage(ctx, site, selected, site == "" && since.IsZero())
	for _, c := range gone {
		b.cdp.call(ctx, b.page, "Network.deleteCookies", map[string]any{"name": c.Name, "domain": c.Domain, "path": c.Path}, nil)
	}
	storageTypes := goSiteStorage
	if b.storageTab.root != "" {
		storageTypes = strings.TrimPrefix(storageTypes, "local_storage,")
	}
	for origin, t := range b.cookies.visits {
		if site != "" && goSite(goOriginHost(origin)) != site || site == "" && t.Before(since) {
			continue
		}
		b.cdp.call(ctx, "", "Storage.clearDataForOrigin", map[string]any{"origin": origin, "storageTypes": storageTypes}, nil)
		if site != "" || since.IsZero() {
			delete(b.cookies.visits, origin)
		}
	}
	if base, err := b.exportCookies(ctx); err == nil {
		b.cookies.base = base
	}
}
