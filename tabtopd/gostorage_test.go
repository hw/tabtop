package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGoStorageSealedAndClear(t *testing.T) {
	path, key := filepath.Join(t.TempDir(), "go-storage.sealed"), newShareKey()
	s := newGoStorage(path, key)
	now := time.Now()
	s.now = func() time.Time { return now }
	a, b, c := "https://example.com", "https://sub.example.com", "https://example.net"
	value := "a secret website setting"
	s.set(a, "private-key", &value)
	s.set(c, "private-key", &value)
	now = now.Add(2 * time.Hour)
	s.set(b, "private-key", &value)
	s.flush()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(value)) || bytes.Contains(raw, []byte("private-key")) {
		t.Fatal("stored data is visible in the sealed file")
	}
	s = newGoStorage(path, key)
	if got := s.items(a)["private-key"]; got != value {
		t.Fatal("sealed data did not reload")
	}
	s.forget("", goForgetRange{since: now.Add(-time.Hour)}, func(selected map[string]bool) {
		if len(selected) != 1 || !selected["example.com"] {
			t.Fatalf("selected sites: %v", selected)
		}
		s.set(a, "stale", &value)
	})
	if s.items(a) != nil || s.items(b) != nil || s.items(c) == nil {
		t.Fatal("time-based clear did not remove the entire matching site")
	}
	s.forget("example.net", goForgetRange{}, func(map[string]bool) {})
	if _, used := s.use(); used != 0 {
		t.Fatalf("after deleting the remaining site, usage = %d", used)
	}
	s.flush()
}

func TestGoStorageQuotas(t *testing.T) {
	s := newGoStorage("", nil)
	now := time.Now()
	s.now = func() time.Time { return now }
	value := strings.Repeat("x", maxGoStorageSite)
	for i := range 10 {
		s.set(fmt.Sprintf("https://site%d.example", i), "", &value)
		now = now.Add(time.Second)
	}
	small := "x"
	s.set("https://sub.site0.example", "", &small)
	if s.items("https://sub.site0.example") != nil {
		t.Fatal("subdomain exceeded the site's quota")
	}
	s.items("https://site0.example")
	now = now.Add(time.Second)
	s.set("https://new.example", "", &value)
	if s.items("https://site1.example") != nil || s.items("https://site0.example") == nil {
		t.Fatal("eviction did not preserve the most recently used site")
	}
	if _, used := s.use(); used != maxGoStorage {
		t.Fatalf("usage = %d, want %d", used, maxGoStorage)
	}
}

func TestGoStorageWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set")
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "http://"+strings.Replace(r.Host, "localhost:", "127.0.0.1:", 1)+"/read", http.StatusFound)
		case "/embed":
			fmt.Fprintf(w, `<iframe src="http://%s/write"></iframe>`, strings.Replace(r.Host, "localhost:", "127.0.0.1:", 1))
		case "/write":
			io.WriteString(w, `<script>localStorage.setItem("first", "saved"); localStorage.setItem("__proto__", "valid"); sessionStorage.setItem("private", "session");</script>`)
		default:
			io.WriteString(w, `<script>window.initial = [localStorage.getItem("first"), localStorage.getItem("__proto__"), sessionStorage.getItem("private")];</script>`)
		}
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	path, key := filepath.Join(t.TempDir(), "go-storage.sealed"), newShareKey()
	store := newGoStorage(path, key)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	open := func() *goBrowser {
		t.Helper()
		e, err := startGoEngine(goEngineConfig{
			engine: moli, mode: goUnsandboxed,
			allow: func(a netip.Addr) bool { return a.Unmap() == netip.MustParseAddr("127.0.0.1") },
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { e.kill("storage test") })
		c, err := dialCDP(ctx, e)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(c.close)
		page, target, err := c.newPageTarget(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{"Page.enable", "Network.enable", "Runtime.enable"} {
			if err := c.call(ctx, page, method, nil, nil); err != nil {
				t.Fatal(err)
			}
		}
		b := newGoBrowser(e, c, page, target)
		b.storage = store
		b.startStorage(ctx)
		if b.storageTab.root == "" {
			t.Fatal("Moli storage interception did not start")
		}
		return b
	}
	pump := func(b *goBrowser) {
		for {
			select {
			case ev := <-b.cdp.Events:
				switch ev.Method {
				case "Page.frameNavigated":
					var p struct {
						Frame struct{ ID, URL string }
					}
					if json.Unmarshal(ev.Params, &p) == nil && p.Frame.ID == b.storageTab.root {
						b.storageShown(p.Frame.URL)
					}
				default:
					b.event(ev)
				}
			default:
				return
			}
		}
	}
	eval := func(b *goBrowser, expression string) string {
		t.Helper()
		var r struct{ Result struct{ Value string } }
		if err := b.cdp.call(ctx, b.page, "Runtime.evaluate",
			map[string]any{"expression": expression, "returnByValue": true}, &r); err != nil {
			t.Fatal(err)
		}
		pump(b)
		return r.Result.Value
	}
	navigate := func(b *goBrowser, path string) {
		t.Helper()
		done := make(chan error, 1)
		go func() {
			base := site.URL
			if path == "/redirect" || path == "/embed" {
				base = strings.Replace(base, "127.0.0.1:", "localhost:", 1)
			}
			done <- b.cdp.call(ctx, b.page, "Page.navigate", map[string]string{"url": base + path}, nil)
		}()
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
				pump(b)
				return
			case <-ticker.C:
				pump(b)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}

	writer := open()
	navigate(writer, "/write")
	eval(writer, "document.readyState")
	writer.endStorage()
	writer.cdp.close()
	writer.e.kill("tab closed")
	store.flush()
	store = newGoStorage(path, key)

	first, second := open(), open()
	navigate(first, "/redirect")
	navigate(second, "/read")
	for _, b := range []*goBrowser{first, second} {
		if got := eval(b, "JSON.stringify(window.initial)"); got != `["saved","valid",null]` {
			t.Fatalf("first inline script saw %q", got)
		}
	}
	awaitChange := func(b *goBrowser, key, value string) {
		t.Helper()
		for store.items(site.URL)[key] != value {
			if ctx.Err() != nil {
				t.Fatal("storage change was not captured")
			}
			pump(b)
			time.Sleep(5 * time.Millisecond)
		}
	}
	eval(first, `localStorage.setItem("first", "updated")`)
	awaitChange(first, "first", "updated")
	eval(second, `localStorage.setItem("second", "kept")`)
	second.endStorage()
	if got := store.items(site.URL); got["first"] != "updated" || got["second"] != "kept" {
		t.Fatal("closing a stale tab did not preserve changes from both tabs")
	}
	clearTabs := func(selected map[string]bool) {
		first.forgetStorage(ctx, "", selected, false, nil)
	}
	store.forget("", goForgetRange{since: time.Now().Add(-time.Hour)}, clearTabs)
	if got := eval(first, "String(localStorage.length)"); got != "0" {
		t.Fatalf("open engine has %s items after time-based clear", got)
	}
	eval(first, `localStorage.setItem("new", "value")`)
	awaitChange(first, "new", "value")
	// All time, the site kept (Keep): spared in the open engine, and in
	// the store; not kept, cleared in both.
	allTime := func(spare map[string]bool) {
		store.forget("", goForgetRange{spare: spare}, func(selected map[string]bool) {
			first.forgetStorage(ctx, "", selected, true, spare)
		})
	}
	allTime(map[string]bool{goStorageSite(site.URL): true})
	if got := eval(first, `String(localStorage.getItem("new"))`); got != "value" || store.items(site.URL)["new"] != "value" {
		t.Fatalf("a kept site's storage cleared with all time: the engine's %q, the store's %v", got, store.items(site.URL))
	}
	allTime(nil)
	if got := eval(first, "String(localStorage.length)"); got != "0" || store.items(site.URL) != nil {
		t.Fatalf("all time left the engine %s items, the store %v", got, store.items(site.URL))
	}
	eval(first, `localStorage.setItem("new", "value")`)
	awaitChange(first, "new", "value")
	store.forget(goStorageSite(site.URL), goForgetRange{}, clearTabs)
	first.endStorage()
	if got := store.items(site.URL); got != nil {
		t.Fatal("closing a cleared tab put storage back")
	}
	embedded := open()
	navigate(embedded, "/embed")
	var partition string
	waitUntil(t, "the embedded page's partition", func() bool {
		eval(embedded, "document.readyState")
		for key := range embedded.storageTab.embedded {
			partition = key
		}
		return partition != ""
	})
	if !strings.HasSuffix(partition, ";top-level-site=http://localhost") || store.items(site.URL) != nil {
		t.Fatalf("wrong embedded partition: %q, top-level stored = %v", partition, store.items(site.URL) != nil)
	}
	store.forget(goStorageSite(site.URL), goForgetRange{}, func(selected map[string]bool) {
		embedded.forgetStorage(ctx, "", selected, false, nil)
	})
	id := goStorageID(site.URL)
	id["storageKey"] = partition
	var frameStorage struct{ Entries [][]string }
	if err := embedded.cdp.call(ctx, embedded.page, "DOMStorage.getDOMStorageItems",
		map[string]any{"storageId": id}, &frameStorage); err != nil || len(frameStorage.Entries) != 0 {
		t.Fatal("deleting the embedded site did not clear its open partition")
	}
	// Stop a navigation while Moli has the request paused. Resuming that
	// stale request returns RequestNotFound, but the tab must survive.
	stopped := open()
	nav := make(chan error, 1)
	go func() {
		nav <- stopped.cdp.call(ctx, stopped.page, "Page.navigate", map[string]string{"url": site.URL + "/read"}, nil)
	}()
	var paused cdpEvent
	for paused.Method != "Fetch.requestPaused" {
		select {
		case paused = <-stopped.cdp.Events:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if err := stopped.cdp.call(ctx, stopped.page, "Page.stopLoading", nil, nil); err != nil {
		t.Fatal(err)
	}
	stopped.storagePaused(paused)
	select {
	case <-nav:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if stopped.cdp.interceptionDisabled.Load() {
		t.Fatal("an ordinary canceled request disabled interception")
	}
	navigate(stopped, "/read")
	if got := eval(stopped, "location.pathname"); got != "/read" {
		t.Fatalf("navigation after Stop: got %q", got)
	}

	// Force the event queue past its reserve. The overflowing pause must
	// release navigation through Fetch.disable, leaving CDP usable.
	overloaded := open()
	for overloaded.cdp.queueEvent(cdpEvent{Method: "Fetch.requestPaused"}) {
	}
	if err := overloaded.cdp.call(ctx, overloaded.page, "Page.navigate", map[string]string{"url": site.URL + "/read"}, nil); err != nil {
		t.Fatal(err)
	}
	for overloaded.cdp.disablingInterception.Load() && ctx.Err() == nil {
		time.Sleep(time.Millisecond)
	}
	if !overloaded.cdp.interceptionDisabled.Load() {
		t.Fatal("the pause overflow did not switch off interception")
	}
	pump(overloaded)
	if got := eval(overloaded, "location.pathname"); got != "/read" {
		t.Fatalf("navigation after event queue overflow: got %q", got)
	}
	store.flush()
}
