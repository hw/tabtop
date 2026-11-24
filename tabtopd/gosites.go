// The remote browser's site settings (go/sites, Site controls, with the
// defaults for every site in its Browser-wide view): sites blocked, which
// the browser doesn't load anything from (the engine's proxy refuses them,
// as the server's own fetches for a page do), and whether a site may open
// pop-ups (allow, block; or, with neither said, ask the person, who may
// have the answer kept). Kept in -go-sites-file (the image's
// ~/.config/tabtop/go-sites.json), the owner's alone.

package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"maps"
	"net"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strconv"
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
	// Dark mode: site -> "auto" (as the person's device), "light", or "dark"
	// (what pages are told the person prefers).
	theme        map[string]string
	themeDefault string
	// Search engine for words typed in the address bar (go.js; chosen in
	// Settings). An id from goSearchEngines, or "custom" (searchURL: an
	// address with %s for the words, goSearchTemplate); default duckduckgo.
	searchEngine, searchURL string
	// Starting tab private (Settings): the first tab /go opens is a private
	// one (goincognito.go; go-tabs.js). New tab and New private tab open
	// their own kinds, and a window a page opens is its tab's, either way.
	privateDefault bool
	// DNS over HTTPS (godoh.go; Settings): "" (off), a goDoHPresets name,
	// or "custom" (dohURL).
	doh, dohURL string
	// Local DNS records (gohosts.go; Settings): names at addresses given.
	hosts []goHostRecord
	// Sites whose cookies and site data are kept (Keep): spared when
	// browsing data is cleared by time, and the last to go when the
	// cookies or storage are over their limits; their session cookies are
	// saved too, so a sign-in lasts a restart (gocookies.go, gostorage.go).
	// Cleared by name, they're cleared.
	keep []string
	// Notifications: site -> "allow" or "block" (a page's
	// Notification.requestPermission answered; unsaid: asked), and how
	// many times they've changed (gonotify.go: a tab's pages told anew).
	notifications map[string]string
	notifyVer     int
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
	Theme        map[string]string `json:"theme,omitempty"`
	ThemeDefault string            `json:"themeDefault,omitempty"`
	SearchEngine string            `json:"searchEngine,omitempty"`
	SearchURL    string            `json:"searchURL,omitempty"`
	// The first tab private.
	PrivateDefault bool           `json:"privateDefault,omitempty"`
	DoH            string         `json:"doh,omitempty"`
	DoHURL         string         `json:"dohURL,omitempty"`
	Hosts          []goHostRecord `json:"hosts,omitempty"`
	Keep           []string       `json:"keep,omitempty"`
	// Notifications allowed or blocked, by site.
	Notifications map[string]string `json:"notifications,omitempty"`
}

// goSearchEngines are the address bar's search engines (Settings; go.js
// builds the URL). DuckDuckGo's HTML version is the default: it works
// with less of the page's own scripts than the others.
var goSearchEngines = map[string]bool{
	"duckduckgo": true, "google": true, "bing": true, "brave": true,
}

// goKeptSite is whether a site's cookies and data are kept (Keep: a
// goSite name). None, till the settings are read.
var goKeptSite = func(string) bool { return false }

// goBlockedHost is whether a host is blocked in the settings: the engine's
// proxy, the server's fetches for a page, and navigations ask it. Nothing,
// till the settings are read.
var goBlockedHost = func(string) bool { return false }

func newGoSiteSettings(file string) *goSiteSettings {
	s := &goSiteSettings{file: file, popups: map[string]string{}, media: map[string]string{}, ads: map[string]string{}, popupDefault: "ask", mediaDefault: "allow",
		theme: map[string]string{}, themeDefault: "auto", searchEngine: "duckduckgo", notifications: map[string]string{}}
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
	if t := themeStored(f.ThemeDefault); themePolicy(t) {
		s.themeDefault = t
	}
	for site, v := range f.Notifications {
		if site = goSettingHost(site); site != "" && (v == "allow" || v == "block") && len(s.notifications) < maxGoSiteSettings {
			s.notifications[goSite(site)] = v
		}
	}
	for site, v := range f.Theme {
		if site = goSettingHost(site); site != "" && themePolicy(themeStored(v)) && len(s.theme) < maxGoSiteSettings {
			s.theme[goSite(site)] = themeStored(v)
		}
	}
	if goSearchEngines[f.SearchEngine] {
		s.searchEngine = f.SearchEngine
	}
	s.privateDefault = f.PrivateDefault
	if t, err := goSearchTemplate(f.SearchURL); err == nil {
		s.searchURL = t
		if f.SearchEngine == "custom" {
			s.searchEngine = "custom"
		}
	}
	if _, preset := goDoHPresets[f.DoH]; preset {
		s.doh = f.DoH
	} else if u, err := goDoHEndpoint(f.DoHURL); f.DoH == "custom" && err == nil {
		s.doh, s.dohURL = "custom", u
	}
	for _, h := range f.Keep {
		if h = goSettingHost(h); h != "" && !slices.Contains(s.keep, goSite(h)) && len(s.keep) < maxGoSiteSettings {
			s.keep = append(s.keep, goSite(h))
		}
	}
	slices.Sort(s.keep)
	// Each record kept that can be (one that can't isn't the end of the
	// others, nor are they of it), as many as may be.
	for _, r := range f.Hosts {
		kept, err := goHostRecords(append(slices.Clone(s.hosts), r))
		if err != nil {
			log.Printf("go: site settings: a local DNS record left out: %v", err)
			continue
		}
		s.hosts = kept
	}
	return s
}

// setSearchCustom has the address bar search at template (checked by
// goSearchTemplate).
func (s *goSiteSettings) setSearchCustom(template string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.searchEngine, s.searchURL = "custom", template
	s.save()
}

// goSearchTemplate is raw if it's a search address: http or https, a host,
// no name and password, and %s once, a query parameter's whole value
// (where the words go; go.js finds them there again).
func goSearchTemplate(raw string) (string, error) {
	t := strings.TrimSpace(raw)
	if t == "" || len(t) > 2048 {
		return "", errors.New("Give the search address, with %s where the words go.")
	}
	if strings.Count(t, "%s") != 1 {
		return "", errors.New("Put %s once in the search address, where the words go.")
	}
	const words = "TABTOPWORDS"
	u, err := url.Parse(strings.Replace(t, "%s", words, 1))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", errors.New("The search address must be an http or https address.")
	}
	if u.User != nil {
		return "", errors.New("The search address mayn't have a name or password in it.")
	}
	if p := u.Port(); p != "" {
		// (As a browser's address takes it: go.js's URL.)
		if n, err := strconv.Atoi(p); err != nil || n > 65535 {
			return "", errors.New("The search address's port isn't one.")
		}
	}
	for _, values := range u.Query() {
		if slices.Contains(values, words) {
			return t, nil
		}
	}
	return "", errors.New("In the search address, %s must be a query parameter's whole value (…?q=%s).")
}

// localHosts is the local DNS records kept.
func (s *goSiteSettings) localHosts() []goHostRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.hosts)
}

// setHosts keeps records (checked by goHostRecords).
func (s *goSiteSettings) setHosts(records []goHostRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hosts = records
	s.save()
}

// dohServer is the DoH server chosen ("" for none), and its addresses if
// they're pinned (a preset's).
func (s *goSiteSettings) dohServer() (string, []netip.Addr) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.doh == "custom" {
		return s.dohURL, nil
	}
	p := goDoHPresets[s.doh]
	return p.endpoint, p.addrs
}

// setDoH chooses DNS over HTTPS: mode "" (off), a preset's name, or
// "custom" with endpoint (checked by goDoHEndpoint).
func (s *goSiteSettings) setDoH(mode, endpoint string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.doh, s.dohURL = mode, ""
	if mode == "custom" {
		s.dohURL = endpoint
	}
	s.save()
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
	f := goSiteSettingsFile{Blocked: s.blocked, Popups: s.popups, Media: s.media, PopupDefault: s.popupDefault, MediaDefault: s.mediaDefault, Ads: s.ads, VideoHosts: s.videoHosts,
		Theme: s.theme, ThemeDefault: s.themeDefault, SearchEngine: s.searchEngine, SearchURL: s.searchURL, PrivateDefault: s.privateDefault, DoH: s.doh, DoHURL: s.dohURL, Hosts: s.hosts, Keep: s.keep,
		Notifications: s.notifications}
	if s.noReferer {
		no := false
		f.Referer = &no
	}
	data, _ := json.MarshalIndent(f, "", " ")
	if err := writeFileAtomic(s.file, data); err != nil {
		log.Printf("go: site settings: saving: %v", err)
	}
}

// kept is whether site's (a goSite name's) cookies and data are kept.
func (s *goSiteSettings) kept(site string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, found := slices.BinarySearch(s.keep, site)
	return found
}

// keptSites is the sites kept, for a clear that spares them.
func (s *goSiteSettings) keptSites() map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]bool, len(s.keep))
	for _, site := range s.keep {
		out[site] = true
	}
	return out
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

func themePolicy(value string) bool {
	return value == "auto" || value == "light" || value == "dark"
}

// themeStored maps a kept Dark mode value to today's: old "force" (invert
// filter on the copy) is "dark" (pages told dark only).
func themeStored(value string) string {
	if value == "force" {
		return "dark"
	}
	return value
}

// notificationsAll is every site's notification setting ("allow" or
// "block"), and the settings' version (notifyVer).
func (s *goSiteSettings) notificationsAll() (map[string]string, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return maps.Clone(s.notifications), s.notifyVer
}

// notificationsVer is how many times the notification settings have changed.
func (s *goSiteSettings) notificationsVer() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.notifyVer
}

// notificationsFor is a page of host's notification setting: its site's
// "allow" or "block", or "" (ask).
func (s *goSiteSettings) notificationsFor(host string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.notifications[goSite(strings.Trim(host, "[]"))]
}

// themeFor is Dark mode for a page of host: its site's, or the default.
func (s *goSiteSettings) themeFor(host string) string {
	if s == nil {
		return "auto"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.theme[goSite(strings.Trim(host, "[]"))]; t != "" {
		return t
	}
	return s.themeDefault
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

// set changes a browser-wide default, site access, or a site's override;
// or (forget) deletes all a site's.
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
		case strings.HasPrefix(setting, "theme-") && themePolicy(strings.TrimPrefix(setting, "theme-")):
			s.themeDefault = strings.TrimPrefix(setting, "theme-")
		case strings.HasPrefix(setting, "search-") && goSearchEngines[strings.TrimPrefix(setting, "search-")]:
			s.searchEngine = strings.TrimPrefix(setting, "search-")
		case setting == "tabs-private" || setting == "tabs-normal":
			s.privateDefault = setting == "tabs-private"
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
	if (strings.HasPrefix(setting, "videos-") || strings.HasPrefix(setting, "ads-") || strings.HasPrefix(setting, "theme-") || strings.HasPrefix(setting, "notifications-") || setting == "keep" || setting == "keep-off") && !strings.HasPrefix(setting, "videos-host-") {
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
	case "theme-auto", "theme-light", "theme-dark":
		if _, ok := s.theme[h]; !ok && len(s.theme) >= maxGoSiteSettings {
			return errors.New("Too many sites have Dark mode settings.")
		}
		s.theme[h] = strings.TrimPrefix(setting, "theme-")
	case "theme-default":
		delete(s.theme, h)
	case "notifications-allow", "notifications-block":
		if _, ok := s.notifications[h]; !ok && len(s.notifications) >= maxGoSiteSettings {
			return errors.New("Too many sites have notification settings.")
		}
		s.notifications[h] = strings.TrimPrefix(setting, "notifications-")
		s.notifyVer++
	case "notifications-default":
		delete(s.notifications, h)
		s.notifyVer++
	case "keep":
		if !slices.Contains(s.keep, h) {
			if len(s.keep) >= maxGoSiteSettings {
				return errors.New("Too many sites are kept.")
			}
			s.keep = append(s.keep, h)
			slices.Sort(s.keep)
		}
	case "keep-off":
		s.keep = slices.DeleteFunc(s.keep, func(k string) bool { return k == h })
	case "forget":
		// Everything kept under the name: its block, its pop-ups, videos and
		// ads, its videos blocked by host, its Keep. (A block of a domain over
		// it, kept under that domain's name, stays.)
		s.blocked = slices.DeleteFunc(s.blocked, func(b string) bool { return b == h })
		delete(s.popups, h)
		delete(s.media, h)
		delete(s.ads, h)
		delete(s.theme, h)
		if _, ok := s.notifications[h]; ok {
			delete(s.notifications, h)
			s.notifyVer++
		}
		s.videoHosts = slices.DeleteFunc(s.videoHosts, func(v string) bool { return v == h })
		s.keep = slices.DeleteFunc(s.keep, func(k string) bool { return k == h })
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
		"mediaDefault": s.mediaDefault, "ads": maps.Clone(s.ads), "videoHosts": slices.Clone(s.videoHosts), "kept": s.file != "",
		"theme": maps.Clone(s.theme), "themeDefault": s.themeDefault, "searchEngine": s.searchEngine, "searchURL": s.searchURL, "privateDefault": s.privateDefault,
		"doh": cmp.Or(s.doh, "off"), "dohURL": s.dohURL, "hosts": append([]goHostRecord{}, s.hosts...), "keep": slices.Clone(s.keep),
		"notifications": maps.Clone(s.notifications)}
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
		report["effectiveTheme"] = g.goSites.themeFor(host)
	}
	if g.goAds != nil {
		report["adblock"] = g.goAds.on.Load() // ad blocking's default, on or off (Settings)
	}
	if d := goDoHNow.Load(); d != nil {
		report["dohStatus"] = d.status()
	}
	c.r.finish(report)
}

// routeGoSettingsSet changes a site's setting (Name: the site; Setting).
func (g *server) routeGoSettingsSet(c *tunnelCall) {
	if !g.goOn || g.goSites == nil {
		c.r.fail("The remote browser is off or unavailable.")
		return
	}
	test := ""
	if c.req.Setting == "doh-test" && c.req.Name == "" {
		// Asked once now (Settings' Test): how it went, in the report.
		d := goDoHNow.Load()
		if d == nil {
			c.r.fail("DNS over HTTPS is off.")
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*goDoHTimeout)
		if err := d.check(ctx); err != nil {
			test = err.Error()
		}
		cancel()
	} else if mode, ok := strings.CutPrefix(c.req.Setting, "doh-"); ok && c.req.Name == "" {
		if err := g.setGoDoH(mode, c.req.URL); err != nil {
			c.r.fail(err.Error())
			return
		}
	} else if c.req.Setting == "search-custom" && c.req.Name == "" {
		t, err := goSearchTemplate(c.req.URL)
		if err != nil {
			c.r.fail(err.Error())
			return
		}
		g.goSites.setSearchCustom(t)
	} else if c.req.Setting == "hosts" && c.req.Name == "" {
		records, err := goHostRecords(c.req.Hosts)
		if err != nil {
			c.r.fail(err.Error())
			return
		}
		// (One change of names at a time: what's kept is what's used.)
		goDoHSetting.Lock()
		g.goSites.setHosts(records)
		goHostsNow.Store(goHostsTable(records))
		goDNSChanged()
		goDoHSetting.Unlock()
	} else if err := g.goSites.set(c.req.Name, c.req.Setting); err != nil {
		c.r.fail(err.Error())
		return
	} else if (c.req.Setting == "keep" || c.req.Setting == "keep-off" || c.req.Setting == "forget") && g.goCookies != nil {
		g.goCookies.saveSoon() // (its session cookies saved, or no longer)
	}
	log.Printf("go: site settings: %s from %s", c.req.Setting, c.ip)
	report := g.goSites.report()
	if d := goDoHNow.Load(); d != nil {
		report["dohStatus"] = d.status()
	}
	if c.req.Setting == "doh-test" {
		report["dohTest"] = test
	}
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

// goDoHSetting is held while DNS over HTTPS is chosen (setGoDoH), or the
// local DNS records are changed.
var goDoHSetting sync.Mutex

// setGoDoH chooses DNS over HTTPS (Settings): mode "off", a preset's name,
// or "custom" with endpoint; a server's taken once it's answered a lookup.
func (g *server) setGoDoH(mode, endpoint string) error {
	// One change at a time: a slow server's check finishing after a later
	// choice doesn't undo it.
	goDoHSetting.Lock()
	defer goDoHSetting.Unlock()
	if mode == "off" {
		g.goSites.setDoH("", "")
		goDoHNow.Store(nil)
		goDNSChanged()
		return nil
	}
	if preset, ok := goDoHPresets[mode]; ok {
		endpoint = preset.endpoint
	} else if mode != "custom" {
		return errors.New("That isn't a DNS over HTTPS choice.")
	} else {
		var err error
		if endpoint, err = goDoHEndpoint(endpoint); err != nil {
			return err
		}
	}
	var pinned []netip.Addr
	if p, ok := goDoHPresets[mode]; ok {
		pinned = p.addrs
	}
	doh := newGoDoH(endpoint, pinned)
	if err := doh.check(context.Background()); err != nil {
		return err
	}
	g.goSites.setDoH(mode, endpoint)
	goDoHNow.Store(doh)
	goDNSChanged()
	return nil
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
	// (Not from a private tab, which keeps nothing of where it went.)
	if remember && !b.private && b.sites != nil && ask.site != "" {
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
