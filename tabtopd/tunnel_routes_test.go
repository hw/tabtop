package main

import (
	"maps"
	"slices"
	"testing"
)

// Every request that reads or changes Downloads, or links to it, needs
// file support: these, and only these.
func TestTunnelRoutesNeedingFiles(t *testing.T) {
	want := []string{"list", "file", "zip", "upload", "mkdir", "create", "rename", "move", "delete", "watch", "changes",
		"zip-preview", "zip-extract", "zip-download", "markdown", "epub", "epub-edit", "cleanup",
		"share", "share-again", "reshare", "reshare-many", "unshare", "fetch", "fetches", "preview-resource", "file-patch", "file-search", "sqlite"}
	var got []string
	for name, route := range tunnelRoutes {
		if route.files {
			got = append(got, name)
		}
	}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("routes needing files:\n got %v\nwant %v", got, want)
	}
}

// With file support off, each is refused through the tunnel, before it's
// served; session management is still served.
func TestTunnelRoutesFilesOff(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	g.fsOff = true
	for _, name := range slices.Sorted(maps.Keys(tunnelRoutes)) {
		if !tunnelRoutes[name].files {
			continue
		}
		r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: name, Path: "x"})
		if r["error"] != "File support is turned off (WEB_FS=0)." {
			t.Errorf("%s with WEB_FS=0: %v", name, r)
		}
	}
	if r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sessions"}); r["error"] != nil {
		t.Errorf("sessions with WEB_FS=0: %v", r)
	}
	if r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "nope"}); r["error"] != "Unknown request." {
		t.Errorf("an unknown request: %v", r)
	}
}
