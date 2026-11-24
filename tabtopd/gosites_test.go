package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// A site, however it's given: its host, lower case, without www.; none
// for what isn't one.
func TestGoSettingHost(t *testing.T) {
	for raw, want := range map[string]string{
		"Example.COM": "example.com", "https://www.example.com/a?b": "example.com", "news.example.co.uk": "news.example.co.uk",
		"http://user@host.example:8080/x": "host.example", "[::1]": "::1", "127.0.0.1": "127.0.0.1",
		"": "", "not a site": "", "a..b": "", "exa$mple.com": "",
	} {
		if got := goSettingHost(raw); got != want {
			t.Errorf("goSettingHost(%q) = %q, want %q", raw, got, want)
		}
	}
}

// A blocked site is blocked with its subdomains, not sites that only end
// the same; pop-up answers are kept, and asked again once forgotten; all
// kept across a restart.
func TestGoSiteSettings(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	s := newGoSiteSettings(file)
	if err := s.set("https://www.ads.example/x", "block"); err != nil {
		t.Fatal(err)
	}
	for host, want := range map[string]bool{"ads.example": true, "cdn.ads.example": true, "badads.example": false, "example": false, "ADS.EXAMPLE.": true} {
		if got := s.isBlocked(host); got != want {
			t.Errorf("isBlocked(%q) = %v", host, got)
		}
	}
	s.set("example.com", "popups-allow")
	s.set("other.org", "popups-block")
	if s.popup("example.com") != "allow" || s.popup("other.org") != "block" || s.popup("new.net") != "ask" {
		t.Errorf("popups %v", s.report())
	}
	if err := s.set("example.com", "nonsense"); err == nil {
		t.Error("took a setting that isn't one")
	}
	again := newGoSiteSettings(file)
	if !again.isBlocked("ads.example") || again.popup("other.org") != "block" {
		t.Errorf("not kept: %v", again.report())
	}
	// Referer: sent at first; off, kept off.
	if !again.sendReferer() {
		t.Error("Referer not sent at first")
	}
	again.set("", "referer-off")
	if newGoSiteSettings(file).sendReferer() {
		t.Error("Referer's setting not kept")
	}
	again.set("other.org", "popups-default")
	again.set("ads.example", "unblock")
	if again.popup("other.org") != "ask" || again.isBlocked("ads.example") {
		t.Errorf("not forgotten: %v", again.report())
	}
}

func TestGoSitePolicyDefaults(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	if err := os.WriteFile(file, []byte(`{"noVideos":["old.example"],"popups":{"existing.example":"allow"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newGoSiteSettings(file)
	for _, change := range [][2]string{
		{"", "popups-block"}, {"", "videos-no-autoplay"},
		{"ask.example", "popups-ask"}, {"sub.allowed.example", "videos-allow"},
	} {
		if err := s.set(change[0], change[1]); err != nil {
			t.Fatal(err)
		}
	}
	s = newGoSiteSettings(file)
	for site, want := range map[string]string{"new.example": "block", "ask.example": "ask", "existing.example": "allow"} {
		if got := s.popup(site); got != want {
			t.Errorf("pop-up policy for %s = %s, want %s", site, got, want)
		}
	}
	for host, want := range map[string]string{"new.example": "no-autoplay", "sub.old.example": "block", "allowed.example": "allow"} {
		if got := s.mediaFor(host); got != want {
			t.Errorf("media policy for %s = %s, want %s", host, got, want)
		}
	}
	if err := s.set("ask.example", "popups-default"); err != nil || s.popup("ask.example") != "block" {
		t.Fatalf("resetting a pop-up override should restore the browser default: %v", err)
	}
	if err := s.set("allowed.example", "videos-default"); err != nil || s.mediaFor("sub.allowed.example") != "no-autoplay" {
		t.Fatalf("resetting a media override should restore the browser default: %v", err)
	}
}

// TestGoSearchEngine keeps the address bar's search engine (Settings) and
// refuses one that isn't offered.
func TestGoSearchEngine(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	s := newGoSiteSettings(file)
	if got := s.report()["searchEngine"]; got != "duckduckgo" {
		t.Fatalf("default searchEngine = %v", got)
	}
	if err := s.set("", "search-google"); err != nil {
		t.Fatal(err)
	}
	if got := s.report()["searchEngine"]; got != "google" {
		t.Fatalf("after set: %v", got)
	}
	if again := newGoSiteSettings(file).report()["searchEngine"]; again != "google" {
		t.Fatalf("not kept: %v", again)
	}
	if err := s.set("", "search-nosuch"); err == nil {
		t.Fatal("took a search engine that isn't offered")
	}
	if err := s.set("example.com", "search-bing"); err == nil {
		t.Fatal("took a search engine as a site setting")
	}
}

// TestGoVideoHosts blocks videos by the host in their own address (a Skip
// held): that host exactly, kept as given, not its site, nor the page's.
func TestGoVideoHosts(t *testing.T) {
	file := filepath.Join(t.TempDir(), "go-sites.json")
	s := newGoSiteSettings(file)
	if err := s.set("https://cdn.videos.example/clips/1.mp4", "videos-host-block"); err != nil {
		t.Fatal(err)
	}
	for host, want := range map[string]bool{"cdn.videos.example": true, "CDN.Videos.Example": true, "www.cdn.videos.example": true,
		"videos.example": false, "a.cdn.videos.example": false, "other.example": false} {
		if got := s.videoHostBlocked(host); got != want {
			t.Errorf("%s: blocked %v, want %v", host, got, want)
		}
	}
	if s.mediaFor("cdn.videos.example") == "block" || s.mediaFor("videos.example") == "block" {
		t.Error("the host's site's own pages' videos blocked too")
	}
	if got := s.report()["videoHosts"].([]string); !slices.Equal(got, []string{"cdn.videos.example"}) {
		t.Errorf("reported %q", got)
	}
	// Kept.
	if !newGoSiteSettings(file).videoHostBlocked("cdn.videos.example") {
		t.Error("not kept")
	}
	if err := s.set("cdn.videos.example", "videos-host-allow"); err != nil || s.videoHostBlocked("cdn.videos.example") {
		t.Errorf("allowed again: %v, still blocked %v", err, s.videoHostBlocked("cdn.videos.example"))
	}
}

// TestGoSiteForget deletes all a site's settings kept under its name: its
// block, pop-ups, videos, ads and videos blocked by host; not another
// site's, nor a domain's block over it; kept so, across a restart.
func TestGoSiteForget(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	s := newGoSiteSettings(file)
	for _, c := range [][2]string{
		{"gone.example", "block"}, {"gone.example", "popups-allow"}, {"gone.example", "videos-block"},
		{"gone.example", "ads-allow"}, {"gone.example", "videos-host-block"},
		{"kept.example", "popups-block"}, {"example", "block"},
	} {
		if err := s.set(c[0], c[1]); err != nil {
			t.Fatal(c, err)
		}
	}
	if err := s.set("gone.example", "forget"); err != nil {
		t.Fatal(err)
	}
	for _, again := range []*goSiteSettings{s, newGoSiteSettings(file)} {
		r := again.report()
		if slices.Contains(r["blocked"].([]string), "gone.example") || r["popups"].(map[string]string)["gone.example"] != "" ||
			r["media"].(map[string]string)["gone.example"] != "" || r["ads"].(map[string]string)["gone.example"] != "" ||
			slices.Contains(r["videoHosts"].([]string), "gone.example") {
			t.Errorf("still kept: %v", r)
		}
		if r["popups"].(map[string]string)["kept.example"] != "block" || !slices.Contains(r["blocked"].([]string), "example") {
			t.Errorf("another's deleted too: %v", r)
		}
	}
}

// TestGoSiteTheme keeps Dark mode: a default (Follow device at first) and
// each site's own, for its subdomains too; deleted with the site's other
// settings; kept across a restart. What a page is told follows it, or the
// device where it's Follow device.
func TestGoSiteTheme(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	s := newGoSiteSettings(file)
	if got := s.themeFor("example.com"); got != "auto" {
		t.Errorf("at first %q", got)
	}
	for _, c := range [][2]string{{"", "theme-dark"}, {"news.example.com", "theme-dark"}, {"light.example", "theme-light"}} {
		if err := s.set(c[0], c[1]); err != nil {
			t.Fatal(c, err)
		}
	}
	if err := s.set("", "theme-sepia"); err == nil {
		t.Error("an unknown Dark mode taken")
	}
	if err := s.set("old.example", "theme-force"); err == nil {
		t.Error("Force dark still taken")
	}
	again := newGoSiteSettings(file)
	for host, want := range map[string]string{"other.com": "dark", "www.example.com": "dark", "light.example": "light"} {
		if got := again.themeFor(host); got != want {
			t.Errorf("%s: %q, want %q", host, got, want)
		}
	}
	b := &goBrowser{sites: again}
	for host, want := range map[string]string{"light.example": "light", "example.com": "dark", "other.com": "dark"} {
		if got := b.schemeFor("https://"+host+"/", "light"); got != want {
			t.Errorf("%s told %q, want %q", host, got, want)
		}
	}
	again.set("", "theme-auto")
	if got := b.schemeFor("https://other.com/", "light"); got != "light" {
		t.Errorf("Follow device told %q", got)
	}
	again.set("example.com", "forget")
	if got := again.themeFor("example.com"); got != "auto" {
		t.Errorf("after forgetting, %q", got)
	}
	legacy := filepath.Join(t.TempDir(), "legacy-theme.json")
	if err := os.WriteFile(legacy, []byte(`{"themeDefault":"force","theme":{"old.example":"force"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	fromLegacy := newGoSiteSettings(legacy)
	if got := fromLegacy.themeFor("anywhere.com"); got != "dark" {
		t.Fatalf("legacy default force: %q", got)
	}
	if got := fromLegacy.themeFor("old.example"); got != "dark" {
		t.Fatalf("legacy site force: %q", got)
	}
}

// TestGoSearchCustom: a custom search address, checked (http or https, %s
// once, a query parameter's whole value), kept and reported; kept too
// while an offered engine's chosen, for choosing again.
func TestGoSearchCustom(t *testing.T) {
	for _, ok := range []string{"https://search.example/?q=%s", " http://s.example/find?lang=en&q=%s ", "https://s.example/s?q=%s&x=1"} {
		if got, err := goSearchTemplate(ok); err != nil || got != strings.TrimSpace(ok) {
			t.Errorf("%q: %q %v", ok, got, err)
		}
	}
	for _, bad := range []string{"", "https://s.example/?q=", "https://s.example/?q=%s&r=%s", "https://s.example/%s", "https://s.example/?q=x%s",
		"ftp://s.example/?q=%s", "https://user:pw@s.example/?q=%s", "s.example/?q=%s", "https://s.example/#q=%s", "https:///?q=%s", "https://s.example:70000/?q=%s"} {
		if _, err := goSearchTemplate(bad); err == nil {
			t.Errorf("%q taken", bad)
		}
	}
	file := filepath.Join(t.TempDir(), "sites.json")
	s := newGoSiteSettings(file)
	s.setSearchCustom("https://search.example/?q=%s")
	if r := s.report(); r["searchEngine"] != "custom" || r["searchURL"] != "https://search.example/?q=%s" {
		t.Fatalf("after set: %v %v", r["searchEngine"], r["searchURL"])
	}
	if r := newGoSiteSettings(file).report(); r["searchEngine"] != "custom" || r["searchURL"] != "https://search.example/?q=%s" {
		t.Fatalf("not kept: %v %v", r["searchEngine"], r["searchURL"])
	}
	if err := s.set("", "search-google"); err != nil {
		t.Fatal(err)
	}
	if r := newGoSiteSettings(file).report(); r["searchEngine"] != "google" || r["searchURL"] != "https://search.example/?q=%s" {
		t.Fatalf("an offered one chosen: %v %v", r["searchEngine"], r["searchURL"])
	}
	// A file whose custom address isn't one: the default.
	if err := os.WriteFile(file, []byte(`{"searchEngine":"custom","searchURL":"https://s.example/%s"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if r := newGoSiteSettings(file).report(); r["searchEngine"] != "duckduckgo" || r["searchURL"] != "" {
		t.Fatalf("a bad custom address taken: %v %v", r["searchEngine"], r["searchURL"])
	}
}

// TestGoPrivateDefault: new tabs private is a browser-wide setting, kept
// in the file, reported; normal again, it's off; a site's isn't taken.
func TestGoPrivateDefault(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	s := newGoSiteSettings(file)
	if s.report()["privateDefault"] != false {
		t.Fatalf("private by default before it's set")
	}
	if err := s.set("", "tabs-private"); err != nil {
		t.Fatal(err)
	}
	if again := newGoSiteSettings(file); again.report()["privateDefault"] != true {
		t.Errorf("not kept in the file")
	}
	if err := s.set("example.com", "tabs-private"); err == nil {
		t.Errorf("a site's new-tabs setting taken")
	}
	if err := s.set("", "tabs-normal"); err != nil || s.report()["privateDefault"] != false {
		t.Errorf("not normal again: %v", err)
	}
}
