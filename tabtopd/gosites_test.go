package main

import (
	"os"
	"path/filepath"
	"slices"
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
