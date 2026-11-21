// The remote browser's site settings (go/sites, Site controls, with the
// defaults for every site in its Browser-wide view): sites blocked, which
// the browser doesn't load anything from (the engine's proxy refuses them,
// as the server's own fetches for a page do), and whether a site may open
// pop-ups (allow, block; or, with neither said, ask the person, who may
// have the answer kept). Kept in -go-sites-file (the image's
// ~/.config/tabtop/go-sites.json), the owner's alone.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"maps"
	"net"
	"os"
	"slices"
	"strings"
	"sync"
)

const maxGoSiteSettings = 2000 // blocked sites and pop-up answers, each

type goSiteSettings struct {
	mu           sync.Mutex
	file         string
	blocked      []string          // hosts: example.com blocks it and its subdomains
	popups       map[string]string // site -> "allow" or "block"
	noReferer    bool              // what's fetched for a page doesn't say the page (Referer)
	media        map[string]string
	ads          map[string]string // site -> "allow" or "block": its ads, whatever ad blocking's default
	videoHosts   []string          // hosts whose videos aren't played, on any page (a Skip held: go.js)
	popupDefault string
	mediaDefault string
}

type goSiteSettingsFile struct {
	Blocked []string          `json:"blocked"`
	Popups  map[string]string `json:"popups"`
	Referer *bool             `json:"referer,omitempty"` // false: not sent; unsaid: sent
	// Sites whose pages' videos and sounds aren't played.
	NoVideos     []string          `json:"noVideos,omitempty"` // legacy blocks
	Media        map[string]string `json:"media,omitempty"`
	PopupDefault string            `json:"popupDefault,omitempty"`
	MediaDefault string            `json:"mediaDefault,omitempty"`
	Ads          map[string]string `json:"ads,omitempty"`
	VideoHosts   []string          `json:"videoHosts,omitempty"`
}

// goBlockedHost is whether a host is blocked in the settings: the engine's
// proxy, the server's fetches for a page, and navigations ask it. Nothing,
// till the settings are read.
var goBlockedHost = func(string) bool { return false }

func newGoSiteSettings(file string) *goSiteSettings {
	s := &goSiteSettings{file: file, popups: map[string]string{}, media: map[string]string{}, ads: map[string]string{}, popupDefault: "ask", mediaDefault: "allow"}
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
	if popupPolicy(f.PopupDefault) {
		s.popupDefault = f.PopupDefault
	}
	if mediaPolicy(f.MediaDefault) {
		s.mediaDefault = f.MediaDefault
	}
	for _, h := range f.NoVideos {
		if h = goSettingHost(h); h != "" && len(s.media) < maxGoSiteSettings {
			s.media[goSite(h)] = "block"
		}
	}
	for site, v := range f.Media {
		if site = goSettingHost(site); site != "" && mediaPolicy(v) {
			if _, exists := s.media[site]; exists || len(s.media) < maxGoSiteSettings {
				s.media[site] = v
			}
		}
	}
	for _, h := range f.VideoHosts {
		if h = goSettingHost(h); h != "" && !slices.Contains(s.videoHosts, h) && len(s.videoHosts) < maxGoSiteSettings {
			s.videoHosts = append(s.videoHosts, h)
		}
	}
	for site, v := range f.Ads {
		if site = goSettingHost(site); site != "" && (v == "allow" || v == "block") && len(s.ads) < maxGoSiteSettings {
			s.ads[goSite(site)] = v
		}
	}
	for site, v := range f.Popups {
		if site = goSettingHost(site); site != "" && popupPolicy(v) && len(s.popups) < maxGoSiteSettings {
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
	f := goSiteSettingsFile{Blocked: s.blocked, Popups: s.popups, Media: s.media, PopupDefault: s.popupDefault, MediaDefault: s.mediaDefault, Ads: s.ads, VideoHosts: s.videoHosts}
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

func popupPolicy(value string) bool { return value == "allow" || value == "block" || value == "ask" }

func mediaPolicy(value string) bool {
	return value == "allow" || value == "block" || value == "no-autoplay"
}

func (s *goSiteSettings) mediaFor(host string) string {
	if s == nil {
		return "allow"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if policy := s.media[goSite(strings.Trim(host, "[]"))]; policy != "" {
		return policy
	}
	return s.mediaDefault
}

// adsFor is how a page at host has its ads: "allow", "block", or "" for
// ad blocking's default. Asked for each request a page makes: with no
// site set either way, as most are, without working out its site.
func (s *goSiteSettings) adsFor(host string) string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.ads) == 0 {
		return ""
	}
	return s.ads[goSite(strings.Trim(host, "[]"))]
}

// videoHostBlocked is whether videos from host aren't played (its own
// host, as a Skip held named it; not its subdomains).
func (s *goSiteSettings) videoHostBlocked(host string) bool {
	if s == nil {
		return false
	}
	h := goSettingHost(host)
	s.mu.Lock()
	defer s.mu.Unlock()
	return h != "" && slices.Contains(s.videoHosts, h)
}

// videoHostList is the hosts whose videos aren't played.
func (s *goSiteSettings) videoHostList() []string {
	if s == nil {
		return []string{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.videoHosts...)
}

// adsBlocked is whether any site's set to have its ads blocked.
func (s *goSiteSettings) adsBlocked() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range s.ads {
		if v == "block" {
			return true
		}
	}
	return false
}

func (s *goSiteSettings) popup(site string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if policy := s.popups[site]; policy != "" {
		return policy
	}
	return s.popupDefault
}

// set changes a browser-wide default, site access, or a site's override.
func (s *goSiteSettings) set(site, setting string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if site == "" {
		switch {
		case setting == "referer-on" || setting == "referer-off":
			s.noReferer = setting == "referer-off"
		case strings.HasPrefix(setting, "popups-") && popupPolicy(strings.TrimPrefix(setting, "popups-")):
			s.popupDefault = strings.TrimPrefix(setting, "popups-")
		case strings.HasPrefix(setting, "videos-") && mediaPolicy(strings.TrimPrefix(setting, "videos-")):
			s.mediaDefault = strings.TrimPrefix(setting, "videos-")
		default:
			return errors.New("That isn't a browser-wide setting.")
		}
		s.save()
		return nil
	}
	h := goSettingHost(site)
	if h == "" {
		return errors.New("That isn't a site's address.")
	}
	// The whole site's (m.youtube.com: youtube.com); a video host's, its
	// own host (cdn.example.com, as its videos' addresses name it).
	if (strings.HasPrefix(setting, "videos-") || strings.HasPrefix(setting, "ads-")) && !strings.HasPrefix(setting, "videos-host-") {
		h = goSite(h)
	}
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
	case "popups-allow", "popups-block", "popups-ask":
		if _, ok := s.popups[h]; !ok && len(s.popups) >= maxGoSiteSettings {
			return errors.New("Too many sites have pop-up settings.")
		}
		s.popups[h] = strings.TrimPrefix(setting, "popups-")
	case "popups-default":
		delete(s.popups, h)
	case "videos-allow", "videos-block", "videos-no-autoplay":
		if _, ok := s.media[h]; !ok && len(s.media) >= maxGoSiteSettings {
			return errors.New("Too many sites have media settings.")
		}
		s.media[h] = strings.TrimPrefix(setting, "videos-")
	case "videos-default":
		delete(s.media, h)
	case "ads-allow", "ads-block":
		if _, ok := s.ads[h]; !ok && len(s.ads) >= maxGoSiteSettings {
			return errors.New("Too many sites have ad settings.")
		}
		s.ads[h] = strings.TrimPrefix(setting, "ads-")
	case "ads-default":
		delete(s.ads, h)
	case "videos-host-block":
		// The host a video comes from (not the page's site): its videos
		// played nowhere.
		if !slices.Contains(s.videoHosts, h) {
			if len(s.videoHosts) >= maxGoSiteSettings {
				return errors.New("Too many video hosts are blocked.")
			}
			s.videoHosts = append(s.videoHosts, h)
			slices.Sort(s.videoHosts)
		}
	case "videos-host-allow":
		s.videoHosts = slices.DeleteFunc(s.videoHosts, func(v string) bool { return v == h })
	default:
		return errors.New("That isn't a setting.")
	}
	s.save()
	return nil
}

func (s *goSiteSettings) report() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var noVideos []string
	for site, policy := range s.media {
		if policy == "block" {
			noVideos = append(noVideos, site)
		}
	}
	slices.Sort(noVideos)
	return map[string]any{"blocked": slices.Clone(s.blocked), "popups": maps.Clone(s.popups), "referer": !s.noReferer,
		"noVideos": noVideos, "media": maps.Clone(s.media), "popupDefault": s.popupDefault,
		"mediaDefault": s.mediaDefault, "ads": maps.Clone(s.ads), "videoHosts": slices.Clone(s.videoHosts), "kept": s.file != ""}
}

// routeGoSettings answers the settings page: what's set.
func (g *server) routeGoSettings(c *tunnelCall) {
	if !g.goOn || g.goSites == nil {
		c.r.fail("The remote browser is off or unavailable.")
		return
	}
	report := g.goSites.report()
	if c.req.Name != "" {
		host := goSettingHost(c.req.Name)
		if host == "" {
			c.r.fail("That isn't a site's address.")
			return
		}
		report["host"], report["site"] = host, goSite(host)
		report["effectiveMedia"] = g.goSites.mediaFor(host)
	}
	if g.goAds != nil {
		report["adblock"] = g.goAds.on.Load() // ad blocking's default, on or off (Settings)
	}
	c.r.finish(report)
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
	report := g.goSites.report()
	if g.goAds != nil {
		report["adblock"] = g.goAds.on.Load()
		if c.req.Setting == "ads-block" {
			// Its lists wanted, if they aren't had (ad blocking off).
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), goAdListTimeout*maxGoAdLists)
				defer cancel()
				g.goAds.updateAll(ctx, goAdMissing)
			}()
		}
	}
	c.r.finish(report)
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
	host := goURLHost(b.docURL)
	if host == "" {
		host = goURLHost(b.url)
	}
	site := goSite(strings.Trim(host, "[]"))
	if goBlockedHost(goURLHost(u)) {
		b.send(map[string]any{"type": "go-popup-blocked", "gen": b.gen, "site": site, "why": "blocked"})
		return
	}
	setting := ""
	if b.sites != nil {
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
