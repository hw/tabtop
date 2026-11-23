package main

import (
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// goKeepSites has goKeptSite say sites are kept, for the test.
func goKeepSites(t *testing.T, sites ...string) {
	was := goKeptSite
	goKeptSite = func(site string) bool { return slices.Contains(sites, site) }
	t.Cleanup(func() { goKeptSite = was })
}

// A site kept is kept by its site (www.facebook.com: facebook.com, its
// subdomains too), across a restart; Keep off, or the site's settings
// deleted, and it isn't.
func TestGoSiteKeep(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	s := newGoSiteSettings(file)
	for _, name := range []string{"www.facebook.com", "linkedin.com"} {
		if err := s.set(name, "keep"); err != nil {
			t.Fatal(name, err)
		}
	}
	again := newGoSiteSettings(file)
	if !again.kept("facebook.com") || !again.kept("linkedin.com") || again.kept("example.com") {
		t.Fatalf("kept after a restart: %v", again.report()["keep"])
	}
	if r := again.report()["keep"].([]string); !slices.Equal(r, []string{"facebook.com", "linkedin.com"}) {
		t.Errorf("reported %v", r)
	}
	if err := again.set("facebook.com", "keep-off"); err != nil || again.kept("facebook.com") {
		t.Errorf("Keep off: %v, still kept %v", err, again.kept("facebook.com"))
	}
	if err := again.set("linkedin.com", "forget"); err != nil || again.kept("linkedin.com") {
		t.Errorf("its settings deleted: %v, still kept %v", err, again.kept("linkedin.com"))
	}
}

// A kept site's session cookies are saved with the jar's others (a sign-in
// lasting a restart); another site's aren't, nor a site's once it isn't
// kept.
func TestGoCookieJarKeptSessions(t *testing.T) {
	goKeepSites(t, "kept.com")
	dir := t.TempDir()
	file, keyFile := filepath.Join(dir, "cookies"), filepath.Join(dir, "key")
	j := newGoCookieJar(file, keyFile)
	session := func(name, domain string) goCookie {
		c := goTestCookie(name, "1", domain)
		c.Session, c.Expires = true, -1
		return c
	}
	j.apply(nil, goCookieMap(session("s", ".kept.com"), session("s", "other.com"), goTestCookie("p", "1", "other.com")))
	j.save()
	again := newGoCookieJar(file, keyFile)
	if again.cookies[goCookieKey{"s", ".kept.com", "/"}] == nil || again.cookies[goCookieKey{"s", "other.com", "/"}] != nil || again.cookies[goCookieKey{"p", "other.com", "/"}] == nil {
		t.Fatalf("after a restart: %v", again.cookies)
	}
	if p := again.cookies[goCookieKey{"s", ".kept.com", "/"}].importParams(); p["expires"] != nil {
		t.Errorf("a session cookie given an engine with an expiry: %v", p)
	}
	goKeepSites(t)
	again.save()
	if third := newGoCookieJar(file, keyFile); third.cookies[goCookieKey{"s", ".kept.com", "/"}] != nil {
		t.Error("a session cookie saved for a site no longer kept")
	}
}

// Cleared by time, a kept site's cookies stay (all time too); cleared by
// name, they go.
func TestGoCookieJarKeptSpared(t *testing.T) {
	j := newGoCookieJar("", "")
	j.apply(nil, goCookieMap(goTestCookie("a", "1", ".kept.com"), goTestCookie("b", "1", "www.kept.com"), goTestCookie("c", "1", "other.com")))
	spare := map[string]bool{"kept.com": true}
	if n := j.forget("", goForgetRange{since: j.now().Add(-time.Hour), spare: spare}); n != 1 {
		t.Errorf("the last hour: %d forgotten", n)
	}
	if n := j.forget("", goForgetRange{spare: spare}); n != 0 || len(j.cookies) != 2 {
		t.Errorf("all time: %d forgotten, %d left", n, len(j.cookies))
	}
	if n := j.forget("kept.com", goForgetRange{}); n != 2 || len(j.cookies) != 0 {
		t.Errorf("by name: %d forgotten, %d left", n, len(j.cookies))
	}
}

// Over its limits, the jar lets a kept site's cookies go last, however
// long since they changed.
func TestGoCookieJarKeptTrimmedLast(t *testing.T) {
	goKeepSites(t, "kept.com")
	clock := time.Unix(1_800_000_000, 0)
	j := newGoCookieJar("", "")
	j.now = func() time.Time { return clock }
	old := map[goCookieKey]goCookie{}
	for i := range 20 {
		c := goTestCookie("k"+string(rune('a'+i)), "1", ".kept.com")
		old[c.key()] = c
	}
	j.apply(nil, old)
	clock = clock.Add(time.Hour)
	more := map[goCookieKey]goCookie{}
	for i := range maxGoCookies {
		c := goTestCookie("o", "1", "other"+strconv.Itoa(i)+".com")
		more[c.key()] = c
	}
	j.apply(nil, more)
	if len(j.cookies) != maxGoCookies {
		t.Fatalf("%d in the jar", len(j.cookies))
	}
	for k := range old {
		if j.cookies[k] == nil {
			t.Fatalf("a kept site's cookie went first: %v", k)
		}
	}
}

// Over the storage's limit, a kept site's goes last, however long unused;
// cleared by time, it's spared, and what it does meanwhile is still taken
// in.
func TestGoStorageKept(t *testing.T) {
	goKeepSites(t, "site0.example")
	s := newGoStorage("", nil)
	now := time.Now()
	s.now = func() time.Time { return now }
	value, little := strings.Repeat("x", maxGoStorageSite), "x"
	s.set("https://site0.example", "", &little)
	for i := 1; i < 10; i++ {
		now = now.Add(time.Second)
		s.set("https://site"+strconv.Itoa(i)+".example", "", &value)
	}
	s.set("https://new.example", "", &value)
	if s.items("https://site0.example") == nil || s.items("https://site1.example") != nil {
		t.Fatal("the kept site, the least lately used, went first")
	}
	small := "y"
	s.forget("", goForgetRange{spare: map[string]bool{"site0.example": true}}, func(sites map[string]bool) {
		if sites["site0.example"] || !sites["new.example"] {
			t.Errorf("cleared in the tabs: %v", sites)
		}
		s.set("https://site0.example", "during", &small)
	})
	if items := s.items("https://site0.example"); items == nil || items["during"] != "y" {
		t.Errorf("the kept site after all time cleared: %v", items)
	}
	if s.items("https://new.example") != nil {
		t.Error("another site spared")
	}
	s.forget("site0.example", goForgetRange{}, func(map[string]bool) {})
	if s.items("https://site0.example") != nil {
		t.Error("the kept site, cleared by name, stayed")
	}
}

// Site controls' clear by time spares the kept sites; by name, clears them.
func TestGoCookiesForgetSparesKept(t *testing.T) {
	g, srv := newE2EServer(t)
	g.goOn = true
	g.goCookies = newGoCookieJar("", "")
	g.goSites = newGoSiteSettings("")
	goKeptSite = g.goSites.kept
	t.Cleanup(func() { goKeptSite = func(string) bool { return false } })
	j := g.goCookies
	j.apply(nil, goCookieMap(goTestCookie("a", "1", ".facebook.com"), goTestCookie("b", "1", ".other.com")))
	s := login(t, testCtx(t), srv.URL, code(0))
	ask := func(req tunnelRequest) map[string]any {
		return openSession(t, testCtx(t), srv.URL, s).request(t, testCtx(t), req)
	}
	if reply := ask(tunnelRequest{Type: "go-settings-set", Name: "www.facebook.com", Setting: "keep"}); reply["ok"] != true {
		t.Fatalf("keep: %v", reply)
	}
	if reply := ask(tunnelRequest{Type: "go-cookies-forget"}); reply["ok"] != true {
		t.Fatalf("all time: %v", reply)
	}
	if j.cookies[goCookieKey{"a", ".facebook.com", "/"}] == nil || j.cookies[goCookieKey{"b", ".other.com", "/"}] != nil {
		t.Fatalf("all time cleared: %v", j.cookies)
	}
	if reply := ask(tunnelRequest{Type: "go-cookies-forget", Names: []string{"facebook.com"}}); reply["ok"] != true {
		t.Fatalf("by name: %v", reply)
	}
	if len(j.cookies) != 0 {
		t.Errorf("by name, kept: %v", j.cookies)
	}
}
