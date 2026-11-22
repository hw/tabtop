package main

// The inspector of a site's data (go/sites, a site's Inspect): its cookies
// kept (gocookies.go), each with what it holds and how it's sent, and the
// localStorage its origins keep (gostorage.go), each item's key and value;
// any one of them deleted, kept and in the tabs open. What's read goes to
// the person's page, through the tunnel, as their own: never to the log,
// which says only that one was deleted.

import (
	"context"
	"log"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// maxGoInspectValue is the most of a value the inspector's sent: past it,
// its start, and its size.
const maxGoInspectValue = 64 << 10

// goCookieRef names a cookie: a site's to delete.
type goCookieRef struct {
	Name   string `json:"name"`
	Domain string `json:"domain"`
	Path   string `json:"path"`
}

// goStorageRef names a localStorage item: an origin's key.
type goStorageRef struct {
	Origin string `json:"origin"`
	Key    string `json:"key"`
}

// goInspectedValue is a value as the inspector shows it: whole, or its
// start, with its size in bytes.
type goInspectedValue struct {
	Value     string `json:"value"`
	Size      int    `json:"size"`
	Truncated bool   `json:"truncated,omitempty"`
}

func goInspect(v string) goInspectedValue {
	out := goInspectedValue{Value: v, Size: len(v)}
	if len(v) > maxGoInspectValue {
		cut := maxGoInspectValue
		for cut > 0 && !utf8.RuneStart(v[cut]) {
			cut--
		}
		out.Value, out.Truncated = v[:cut], true
	}
	return out
}

// goInspectedCookie is a cookie as the inspector shows it (goCookie's
// fields, its value as goInspect has it).
type goInspectedCookie struct {
	Name     string  `json:"name"`
	Domain   string  `json:"domain"`
	Path     string  `json:"path"`
	Expires  float64 `json:"expires"` // seconds since 1970; -1 for a session cookie
	HTTPOnly bool    `json:"httpOnly"`
	Secure   bool    `json:"secure"`
	SameSite string  `json:"sameSite,omitempty"`
	Session  bool    `json:"session"`
	Changed  int64   `json:"changed,omitempty"` // unix ms
	goInspectedValue
}

type goInspectedItem struct {
	Key string `json:"key"`
	goInspectedValue
}

type goInspectedOrigin struct {
	Origin  string            `json:"origin"`
	Changed int64             `json:"changed,omitempty"` // unix ms
	Items   []goInspectedItem `json:"items"`
}

// routeGoSiteData has a site's (Name) cookies and localStorage, as the
// inspector shows them: the open tabs' cookies taken in first, so it's what
// they have now.
func (g *server) routeGoSiteData(c *tunnelCall) {
	if !g.goOn || g.goCookies == nil {
		c.r.fail("The remote browser is off or unavailable, so it keeps no site data.")
		return
	}
	site := strings.ToLower(strings.TrimSpace(c.req.Name))
	if site == "" || len(site) > 253 {
		c.r.fail("That isn't a site.")
		return
	}
	g.goCookies.mu.Lock()
	tabs := g.goCookies.tabList()
	g.goCookies.mu.Unlock()
	for _, b := range tabs {
		b.syncCookies()
	}
	r := map[string]any{"site": site, "cookies": g.goCookies.siteCookies(site)}
	if g.goStorage != nil {
		r["storage"] = g.goStorage.siteItems(site)
	}
	c.r.finish(r)
}

// routeGoSiteDataDelete deletes one of a site's (Name) cookies (Cookie), or
// one of its localStorage items (Storage): kept, and in the tabs open. It
// answers as go-site-data does, with what's left.
func (g *server) routeGoSiteDataDelete(c *tunnelCall) {
	if !g.goOn || g.goCookies == nil {
		c.r.fail("The remote browser is off or unavailable, so it keeps no site data.")
		return
	}
	site := strings.ToLower(strings.TrimSpace(c.req.Name))
	switch {
	case site == "" || len(site) > 253:
		c.r.fail("That isn't a site.")
		return
	case c.req.Cookie != nil:
		ref := *c.req.Cookie
		if goSite(strings.TrimPrefix(ref.Domain, ".")) != site {
			c.r.fail("That cookie isn't the site's.")
			return
		}
		g.goCookies.forgetOne(goCookieKey{ref.Name, ref.Domain, ref.Path})
		log.Printf("go: site data: a cookie deleted from %s", c.ip)
	case c.req.Storage != nil && g.goStorage != nil:
		ref := *c.req.Storage
		origin := goStorageOriginOf(ref.Origin)
		if origin == "" || goStorageSite(origin) != site {
			c.r.fail("That item isn't the site's.")
			return
		}
		g.goStorage.set(origin, ref.Key, nil)
		g.goCookies.mu.Lock()
		tabs := g.goCookies.tabList()
		g.goCookies.mu.Unlock()
		for _, b := range tabs {
			b.forgetStorageItem(origin, ref.Key)
		}
		log.Printf("go: site data: a storage item deleted from %s", c.ip)
	default:
		c.r.fail("Say which cookie or item to delete.")
		return
	}
	g.routeGoSiteData(c)
}

// siteCookies is the site's cookies kept, not expired: by name, then
// domain and path.
func (j *goCookieJar) siteCookies(site string) []goInspectedCookie {
	j.mu.Lock()
	defer j.mu.Unlock()
	now := j.now()
	out := []goInspectedCookie{}
	for _, c := range j.cookies {
		if c.expired(now) || goSite(c.host()) != site {
			continue
		}
		out = append(out, goInspectedCookie{Name: c.Name, Domain: c.Domain, Path: c.Path, Expires: c.Expires, HTTPOnly: c.HTTPOnly,
			Secure: c.Secure, SameSite: c.SameSite, Session: c.Session, Changed: c.Changed, goInspectedValue: goInspect(c.Value)})
	}
	slices.SortFunc(out, func(a, b goInspectedCookie) int {
		return strings.Compare(a.Name+"\x00"+a.Domain+"\x00"+a.Path, b.Name+"\x00"+b.Domain+"\x00"+b.Path)
	})
	return out
}

// forgetOne deletes the cookie of key: kept, and in the tabs open (where
// what the tab last had of it goes too, so it's not taken as removed by
// the page, nor kept again).
func (j *goCookieJar) forgetOne(k goCookieKey) {
	j.mu.Lock()
	if _, ok := j.cookies[k]; ok {
		delete(j.cookies, k)
		j.saveSoonLocked()
	}
	tabs := j.tabList()
	j.mu.Unlock()
	for _, b := range tabs {
		b.forgetCookie(k)
	}
}

func (b *goBrowser) forgetCookie(k goCookieKey) {
	b.cookies.mu.Lock()
	defer b.cookies.mu.Unlock()
	if !b.cookies.started {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Out of what the tab last had only once it's gone from the engine: a
	// delete that failed leaves it there and in base, so it isn't taken as
	// set anew and kept again. (Only k: base taken whole from the engine
	// would lose what the tab's set since it last synced, never kept.)
	if b.cdp.call(ctx, b.page, "Network.deleteCookies", map[string]any{"name": k.name, "domain": k.domain, "path": k.path}, nil) == nil {
		delete(b.cookies.base, k)
	}
}

// siteItems is the site's origins' localStorage kept: by origin, then key.
func (s *goStorage) siteItems(site string) []goInspectedOrigin {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []goInspectedOrigin{}
	if s.clearAll || s.clearing[site] {
		return out
	}
	for origin, o := range s.origins {
		if goStorageSite(origin) != site {
			continue
		}
		entry := goInspectedOrigin{Origin: origin, Changed: o.Changed, Items: make([]goInspectedItem, 0, len(o.Items))}
		for k, v := range o.Items {
			entry.Items = append(entry.Items, goInspectedItem{k, goInspect(v)})
		}
		slices.SortFunc(entry.Items, func(a, b goInspectedItem) int { return strings.Compare(a.Key, b.Key) })
		out = append(out, entry)
	}
	slices.SortFunc(out, func(a, b goInspectedOrigin) int { return strings.Compare(a.Origin, b.Origin) })
	return out
}

// forgetStorageItem deletes origin's key in the tab, if its page is of
// origin: from the engine's storage, and from what its document was given
// and has (so it's neither put back, as the page loads again, nor taken
// as removed by the page).
func (b *goBrowser) forgetStorageItem(origin, key string) {
	t := &b.storageTab
	t.mu.Lock() // (root's set by the tab's start, on another goroutine: startStorage)
	defer t.mu.Unlock()
	if t.root == "" {
		return
	}
	doc := t.documents[origin]
	if doc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	defer cancel()
	if _, seeded := doc.seed[key]; seeded && doc.script != "" {
		// What's put back as the page loads, again without it.
		// (The old one not removed: kept, its id with it, not lost under a
		// new one's.)
		b.removeStorageScript(ctx, doc)
		delete(doc.seed, key)
		var r struct {
			Identifier string `json:"identifier"`
		}
		if doc.script == "" && len(doc.seed) > 0 && b.cdp.call(ctx, b.page, "Page.addScriptToEvaluateOnNewDocument", map[string]string{
			"source": goStorageRestore(origin, doc.seed), "worldName": "tabtop-site-storage",
		}, &r) == nil {
			doc.script = r.Identifier
		}
	}
	delete(doc.seed, key)
	// Out of what the document was given only once it's gone from the
	// engine: still there, it's not taken as set anew and kept again.
	if b.cdp.call(ctx, b.page, "DOMStorage.removeDOMStorageItem", map[string]any{"storageId": goStorageID(origin), "key": key}, nil) == nil {
		delete(doc.base, key)
	}
}
