package main

import (
	"path/filepath"
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
	if s.popup("example.com") != "allow" || s.popup("other.org") != "block" || s.popup("new.net") != "" {
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
	again.set("other.org", "popups-ask")
	again.set("ads.example", "unblock")
	if again.popup("other.org") != "" || again.isBlocked("ads.example") {
		t.Errorf("not forgotten: %v", again.report())
	}
}
