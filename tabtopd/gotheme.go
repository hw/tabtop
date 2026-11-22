package main

// Dark mode in the remote browser (go/sites: a default, and each site's
// own): what a tab's pages are told the person prefers, light or dark
// (prefers-color-scheme, in CSS and matchMedia), as the setting for the
// page's site says (Light, Dark), or else as the person's own device does
// (Follow device: goView.Scheme). Told as each top document is asked for
// (storagePaused; or, without that, as it's committed), before its styles
// are read; and again as the device's changes, or the setting does.

import (
	"context"
	"sync"
)

type goColors struct {
	mu     sync.Mutex
	page   string // the top document's address
	device string // the person's device's: "light" or "dark" ("" until said)
	sent   string // what the engine was last told
}

// schemeFor is what a page at raw is told: its site's Dark mode, or the
// device's.
func (b *goBrowser) schemeFor(raw, device string) string {
	switch b.sites.themeFor(goURLHost(raw)) {
	case "light":
		return "light"
	case "dark":
		return "dark"
	}
	return device
}

// schemeAt has the engine tell the page now at raw (raw "": the page it's
// at) light or dark, as schemeFor says; nothing if that's what it was told.
func (b *goBrowser) schemeAt(raw string) {
	c := &b.colors
	c.mu.Lock()
	defer c.mu.Unlock()
	if raw != "" {
		c.page = raw
	}
	want := b.schemeFor(c.page, c.device)
	if want == "" || want == c.sent || b.cdp == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	defer cancel()
	if err := b.cdp.call(ctx, b.page, "Emulation.setEmulatedMedia", map[string]any{
		"features": []map[string]string{{"name": "prefers-color-scheme", "value": want}},
	}, nil); err != nil {
		goDebugf("color scheme emulation %q: %v", want, err)
		return
	}
	c.sent = want
}

// deviceScheme is the person's device's light or dark, said: the page told
// again, if that changes what it's told.
func (b *goBrowser) deviceScheme(scheme string) {
	b.colors.mu.Lock()
	b.colors.device = scheme
	b.colors.mu.Unlock()
	b.schemeAt("")
}

// goSchemeOf is the scheme the copy of a page at raw must take for its
// styles, whatever the person's own device prefers: its site's Dark mode,
// if that's Light or Dark; "" for Follow device (the device's is the
// viewer's own, which the copy's styles already go by).
func (b *goBrowser) goSchemeOf(raw string) string {
	switch t := b.sites.themeFor(goURLHost(raw)); t {
	case "light", "dark":
		return t
	}
	return ""
}
