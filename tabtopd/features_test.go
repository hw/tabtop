package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFeatureConfigurations(t *testing.T) {
	for mask := 1; mask < 8; mask++ {
		c := validTestConfig()
		c.vncOff, c.fsOff = mask&1 == 0, mask&4 == 0
		if mask&2 != 0 {
			c.termDir = "terminal"
		}
		c.shareOn, c.fetchOn = true, true
		if c.fsOff {
			c.downloadsDir = ""
		}
		if c.vncOff {
			c.vncAddr = ""
			c.audioSink = "sink"
		}
		g, err := newServer(c)
		if err != nil {
			t.Fatalf("mask %d: %v", mask, err)
		}
		if c.fsOff && (g.shares != nil || g.fetches != nil) {
			t.Fatal("disabled files initialized shares or fetching")
		}
		if c.vncOff && g.audio != nil {
			t.Fatal("disabled desktop initialized audio")
		}
	}
	c := validTestConfig()
	c.vncOff, c.fsOff = true, true
	if _, err := newServer(c); err == nil {
		t.Fatal("all services disabled was accepted")
	}
}

func TestDisabledFeatureEndpointsAndNavigation(t *testing.T) {
	for _, mode := range []string{"files", "terminal", "desktop"} {
		t.Run(mode, func(t *testing.T) {
			g, _ := newE2EServer(t)
			g.vncOff, g.fsOff = mode != "desktop", mode != "files"
			if mode != "terminal" {
				g.termDir = ""
			}
			h := g.handler()
			for path, on := range map[string]bool{"/vnc.html": !g.vncOff, "/core/rfb.js": false, "/fs/": !g.fsOff, "/fs": !g.fsOff, "/tty/": g.termDir != "", "/tty": g.termDir != ""} {
				w := httptest.NewRecorder()
				h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
				if (w.Code != http.StatusNotFound) != on {
					t.Errorf("%s: status %d, enabled %t", path, w.Code, on)
				}
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/tabtop/nav.js", nil))
			for id, on := range map[string]bool{"desktop": !g.vncOff, "files": !g.fsOff, "terminal": g.termDir != ""} {
				want := `"` + id + `":false`
				if on {
					want = `"` + id + `":true`
				}
				if !strings.Contains(w.Body.String(), want) {
					t.Errorf("navigation omitted %s", want)
				}
			}
			if g.vncOff {
				w = httptest.NewRecorder()
				h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
				target := filesPrefix
				if mode == "terminal" {
					target = ttyPrefix
				}
				if w.Code != 303 || w.Header().Get("Location") != target {
					t.Fatalf("landing page: %d %s", w.Code, w.Header().Get("Location"))
				}
			}
		})
	}
}

func TestDisabledFeatureTunnels(t *testing.T) {
	g, srv := newE2EServer(t)
	g.vncOff, g.fsOff, g.termDir = true, true, ""
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	for _, kind := range []string{"vnc", "tty", "list", "file", "zip", "upload", "mkdir", "create", "rename", "move", "delete", "watch", "changes", "zip-preview", "zip-extract", "zip-download", "markdown", "epub", "epub-edit", "sqlite", "cleanup", "share", "share-again", "reshare", "reshare-many", "unshare", "fetch", "fetches"} {
		r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: kind})
		message, _ := r["error"].(string)
		if r["ok"] == true || !strings.Contains(message, "turned off") {
			t.Fatalf("%s was not gated: %v", kind, r)
		}
	}
	if r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sessions"}); r["ok"] != true {
		t.Fatal("session management disabled", r)
	}
}

func TestDisabledDesktopHealthAndDoctor(t *testing.T) {
	g, srv := newDoctorServer(t, true)
	g.vncOff, g.fsOff = true, true
	g.vncAddr, g.novncDir, g.downloadsDir = "unix:/missing-vnc.sock", "/missing-novnc", "/missing-downloads"
	if status, _ := fetch(t, srv.URL+"/healthz"); status != 200 {
		t.Fatalf("desktop-free health: %d", status)
	}
	report := g.collectDoctorReport(httptest.NewRequest("GET", "/doctor", nil))
	for _, name := range []string{"vnc", "novnc", "downloads"} {
		if c := report.Checks[name]; !c.OK || c.Detail != "off" {
			t.Errorf("%s: %+v", name, c)
		}
	}
}
