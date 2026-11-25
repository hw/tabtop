package main

import (
	"net/http"
	"strings"
)

// setPageHeaders sets what guards a page: its Content-Security-Policy
// (csp), its type taken as served (nosniff), its address told to none
// (Referrer-Policy), and, where csp lets no site frame it (frame-ancestors
// 'none'), X-Frame-Options too, for browsers older than frame-ancestors.
// (A page framed by its own site, frame-ancestors 'self', is given no
// X-Frame-Options: SAMEORIGIN is judged against every ancestor, a
// sandboxed one's opaque origin among them.)
func setPageHeaders(h http.Header, csp string) {
	h.Set("Content-Security-Policy", csp)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	if strings.Contains(csp, "frame-ancestors 'none'") {
		h.Set("X-Frame-Options", "DENY")
	}
}
