// The remote browser's site settings (go/settings): sites blocked, which
// the browser doesn't load anything from (the engine's proxy refuses them,
// as the server's own fetches for a page do), and whether a site may open
// pop-ups (allow, block; or, with neither said, ask the person, who may
// have the answer kept). Kept in -go-sites-file (the image's
// ~/.config/tabtop/go-sites.json), the owner's alone.

package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net"
	"os"
	"slices"
	"strings"
	"sync"
)

const maxGoSiteSettings = 2000 // blocked sites and pop-up answers, each

type goSiteSettings struct {
	mu        sync.Mutex
	file      string
	blocked   []string          // hosts: example.com blocks it and its subdomains
	popups    map[string]string // site -> "allow" or "block"
	noReferer bool              // what's fetched for a page doesn't say the page (Referer)
}

type goSiteSettingsFile struct {
	Blocked []string          `json:"blocked"`
	Popups  map[string]string `json:"popups"`
	Referer *bool             `json:"referer,omitempty"` // false: not sent; unsaid: sent
}

// goBlockedHost is whether a host is blocked in the settings: the engine's
// proxy, the server's fetches for a page, and navigations ask it. Nothing,
// till the settings are read.
var goBlockedHost = func(string) bool { return false }

func newGoSiteSettings(file string) *goSiteSettings {
	s := &goSiteSettings{file: file, popups: map[string]string{}}
	if file == "" {
		return s
	}
	data, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return s
	}
	var f goSiteSettingsFile
	if err == nil {
		err = json.Unmarshal(data, &f)
	}
	if err != nil {
		if aside, aerr := setAside(file); aerr == nil {
			log.Printf("go: site settings: %s couldn't be read (%v); set aside as %s", file, err, aside)
		} else {
			log.Printf("go: site settings: %s couldn't be read (%v) nor set aside (%v); kept in memory only", file, err, aerr)
			s.file = ""
		}
		return s
	}
	for _, h := range f.Blocked {
		if h = goSettingHost(h); h != "" && !slices.Contains(s.blocked, h) && len(s.blocked) < maxGoSiteSettings {
			s.blocked = append(s.blocked, h)
		}
	}
	s.noReferer = f.Referer != nil && !*f.Referer
	for site, v := range f.Popups {
		if site = goSettingHost(site); site != "" && (v == "allow" || v == "block") && len(s.popups) < maxGoSiteSettings {
			s.popups[site] = v
		}
	}
	return s
}

// goSettingHost is what was typed or given for a site as a host: an
// address's host, lower case, without "www."; "" if it isn't one.
func goSettingHost(raw string) string {
	h := strings.ToLower(strings.TrimSpace(raw))
	if i := strings.Index(h, "://"); i >= 0 {
		h = h[i+3:]
	}
	h, _, _ = strings.Cut(h, "/")
	h, _, _ = strings.Cut(h, "?")
	h, _, _ = strings.Cut(h, "#")
	if _, rest, ok := strings.Cut(h, "@"); ok {
		h = rest
	}
	if hh, _, err := net.SplitHostPort(h); err == nil {
		h = hh
	}
	h = strings.TrimSuffix(strings.TrimPrefix(h, "www."), ".")
	h = strings.Trim(h, "[]")
	if h == "" || len(h) > 253 {
		return ""
	}
	if net.ParseIP(h) != nil {
		return h
	}
	for _, label := range strings.Split(h, ".") {
		if label == "" || len(label) > 63 {
			return ""
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
				return ""
			}
		}
	}
	return h
}

func (s *goSiteSettings) save() {
	if s.file == "" {
		return
	}
	f := goSiteSettingsFile{Blocked: s.blocked, Popups: s.popups}
	if s.noReferer {
		no := false
		f.Referer = &no
	}
	data, _ := json.MarshalIndent(f, "", " ")
	if err := writeFileAtomic(s.file, data); err != nil {
		log.Printf("go: site settings: saving: %v", err)
	}
}

// isBlocked is whether host is a blocked site's, or a subdomain of one.
func (s *goSiteSettings) isBlocked(host string) bool {
	host = strings.TrimSuffix(strings.Trim(strings.ToLower(host), "[]"), ".")
	if host == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range s.blocked {
		if host == b || strings.HasSuffix(host, "."+b) {
			return true
		}
	}
	return false
}

// sendReferer is whether what's fetched for a page (pictures, fonts,
// stylesheets, media) says the page, as a browser does (Referer).
func (s *goSiteSettings) sendReferer() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.noReferer
}

// popup is what's said for a site's pop-ups: "allow", "block", or "" (ask).
func (s *goSiteSettings) popup(site string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.popups[site]
}

// set changes a site's setting: "block" or "unblock" it, or its pop-ups
// "popups-allow", "popups-block" or "popups-ask" (forget the answer).
func (s *goSiteSettings) set(site, setting string) error {
	if setting == "referer-on" || setting == "referer-off" {
		// Not a site's: all of them.
		s.mu.Lock()
		defer s.mu.Unlock()
		s.noReferer = setting == "referer-off"
		s.save()
		return nil
	}
	h := goSettingHost(site)
	if h == "" {
		return errors.New("That isn't a site's address.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch setting {
	case "block":
		if !slices.Contains(s.blocked, h) {
			if len(s.blocked) >= maxGoSiteSettings {
				return errors.New("Too many sites are blocked.")
			}
			s.blocked = append(s.blocked, h)
			slices.Sort(s.blocked)
		}
	case "unblock":
		s.blocked = slices.DeleteFunc(s.blocked, func(b string) bool { return b == h })
	case "popups-allow", "popups-block":
		if _, ok := s.popups[h]; !ok && len(s.popups) >= maxGoSiteSettings {
			return errors.New("Too many sites have pop-up settings.")
		}
		s.popups[h] = strings.TrimPrefix(setting, "popups-")
	case "popups-ask":
		delete(s.popups, h)
	default:
		return errors.New("That isn't a setting.")
	}
	s.save()
	return nil
}

func (s *goSiteSettings) report() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	popups := map[string]string{}
	for k, v := range s.popups {
		popups[k] = v
	}
	return map[string]any{"blocked": slices.Clone(s.blocked), "popups": popups, "referer": !s.noReferer, "kept": s.file != ""}
}

// routeGoSettings answers the settings page: what's set.
func (g *server) routeGoSettings(c *tunnelCall) {
	if !g.goOn || g.goSites == nil {
		c.r.fail("The remote browser is off or unavailable.")
		return
	}
	c.r.finish(g.goSites.report())
}

// routeGoSettingsSet changes a site's setting (Name: the site; Setting).
func (g *server) routeGoSettingsSet(c *tunnelCall) {
	if !g.goOn || g.goSites == nil {
		c.r.fail("The remote browser is off or unavailable.")
		return
	}
	if err := g.goSites.set(c.req.Name, c.req.Setting); err != nil {
		c.r.fail(err.Error())
		return
	}
	log.Printf("go: site settings: %s from %s", c.req.Setting, c.ip)
	c.r.finish(g.goSites.report())
}

// --- Pop-ups -----------------------------------------------------------------

// goPopupAsk is a pop-up the person's asked about: where it goes, and the
// site that opened it (whose setting an answer kept is).
type goPopupAsk struct {
	url, site string
}

// popup decides a window the page opened (u): opened, as the opener's site
// says, or refused, or the person asked.
func (b *goBrowser) popup(u string) {
	site := ""
	if host := goURLHost(b.url); host != "" {
		site = goSite(host)
	}
	if goBlockedHost(goURLHost(u)) {
		b.send(map[string]any{"type": "go-popup-blocked", "gen": b.gen, "site": site, "why": "blocked"})
		return
	}
	setting := ""
	if b.sites != nil && site != "" {
		setting = b.sites.popup(site)
	}
	switch setting {
	case "allow":
		b.send(map[string]any{"type": "go-popup", "gen": b.gen, "url": u})
	case "block":
		goDebugf("popup: refused, as the site's setting says")
		b.send(map[string]any{"type": "go-popup-blocked", "gen": b.gen, "site": site})
	default:
		if b.popupAsks == nil {
			b.popupAsks = map[int]goPopupAsk{}
		}
		if len(b.popupAsks) >= 8 {
			return // a page opening windows in a loop: not asked about each
		}
		b.popupAsk++
		b.popupAsks[b.popupAsk] = goPopupAsk{url: u, site: site}
		b.send(map[string]any{"type": "go-popup-ask", "gen": b.gen, "id": b.popupAsk, "url": u, "site": site})
	}
}

// popupAnswer is the person's answer about a pop-up (id): opened if allowed,
// and, if they said to, the answer kept for its site.
func (b *goBrowser) popupAnswer(id int, allow, remember bool) {
	ask, ok := b.popupAsks[id]
	if !ok {
		return
	}
	delete(b.popupAsks, id)
	if remember && b.sites != nil && ask.site != "" {
		setting := "popups-block"
		if allow {
			setting = "popups-allow"
		}
		if err := b.sites.set(ask.site, setting); err != nil {
			goDebugf("popup: keeping the answer: %v", err)
		}
	}
	if allow {
		b.send(map[string]any{"type": "go-popup", "gen": b.gen, "url": ask.url})
	}
}

// goURLHost is an address's host, "" if it has none.
func goURLHost(raw string) string {
	o := goOrigin(raw)
	if o == "" {
		return ""
	}
	return goOriginHost(o)
}
