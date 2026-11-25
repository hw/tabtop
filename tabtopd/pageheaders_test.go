package main

import (
	"net/http"
	"strings"
	"testing"
)

// TestPageCSPs: every page's CSP lets no <base> move its relative
// addresses, says where forms may go, and who may frame it; each is set
// with the rest of a page's guards.
func TestPageCSPs(t *testing.T) {
	pages := map[string]string{
		"files": filesCSP, "terminal": ttyCSP, "desktop": novncCSP(t.TempDir()), "approval": approveCSP,
		"doctor": doctorCSP, "share": sharePageCSP, "go tabs": goTabsCSP, "go tab": goPageCSP,
		"go settings": goCookiesCSP, "go frame": goFrameCSP,
	}
	for name, csp := range pages {
		for _, want := range []string{"base-uri 'none'", "form-action ", "frame-ancestors "} {
			if !strings.Contains(csp, want) {
				t.Errorf("%s's CSP has no %q: %s", name, want, csp)
			}
		}
	}
	h := http.Header{}
	setPageHeaders(h, filesCSP)
	if h.Get("X-Frame-Options") != "DENY" || h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("a page no site may frame: %v", h)
	}
	h = http.Header{}
	setPageHeaders(h, goPageCSP)
	if h.Get("X-Frame-Options") != "" {
		t.Errorf("a page its own site frames was given X-Frame-Options %q", h.Get("X-Frame-Options"))
	}
}
