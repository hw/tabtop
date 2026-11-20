package main

import (
	"strings"
	"testing"
)

// A phone's tab says it's Chrome on Android, at the engine's version, in
// all it says: never TabTop, never the desktop's platform.
func TestGoPhoneProfile(t *testing.T) {
	ua, p := goPhoneProfile("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.74 Safari/537.36")
	if ua != "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36" || p["userAgent"] != ua {
		t.Errorf("user agent %q", ua)
	}
	meta := p["userAgentMetadata"].(map[string]any)
	if meta["platform"] != "Android" || meta["mobile"] != true || p["platform"] != "Linux armv81" {
		t.Errorf("hints %v", p)
	}
	if full := meta["fullVersionList"].([]map[string]string); full[0]["version"] != "156.0.8078.74" {
		t.Errorf("full version %v", full)
	}
	if strings.Contains(strings.ToLower(ua), "tabtop") || strings.Contains(strings.ToLower(goDesktopUA), "tabtop") {
		t.Error("says it's TabTop")
	}
	// An engine that doesn't say its version: the default's.
	if ua, _ := goPhoneProfile("Mozilla/5.0"); !strings.Contains(ua, "Chrome/156.0.0.0 Mobile") {
		t.Errorf("no version: %q", ua)
	}
}

func TestGoPhone(t *testing.T) {
	for _, c := range []struct {
		v    goView
		want bool
	}{
		{goView{Touch: true, SW: 390, SH: 844}, true},
		{goView{Touch: true, SW: 844, SH: 390}, true},   // turned
		{goView{Touch: true, SW: 820, SH: 1180}, false}, // a tablet
		{goView{Touch: false, SW: 390, SH: 844}, false}, // a narrow window, no touch
		{goView{Touch: true}, false},
	} {
		if got := goPhone(c.v); got != c.want {
			t.Errorf("%+v: %v", c.v, got)
		}
	}
}
