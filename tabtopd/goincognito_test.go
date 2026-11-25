package main

import (
	"net/url"
	"testing"
	"time"
)

// A session's private tabs share a jar and a storage of their own, not
// the account's, apart from another session's, forgotten with the last
// that holds them; a restart keeps them a while.
func TestGoPrivateJar(t *testing.T) {
	g := &server{}
	g.goCookies = newGoCookieJar("", "")
	g.goStorage = newGoStorage("", nil)
	p1, release1 := g.goPrivates.privateFor("s1")
	p2, release2 := g.goPrivates.privateFor("s1")
	other, releaseOther := g.goPrivates.privateFor("s2")
	defer releaseOther()
	if p1 != p2 || p1.jar == other.jar || p1.jar == g.goCookies || p1.storage == g.goStorage || p1.storage == other.storage {
		t.Fatal("private jars aren't the session's own")
	}
	if p1.jar.file != "" || p1.storage.file != "" {
		t.Fatal("a private jar or storage is kept in a file")
	}
	c := goTestCookie("sid", "secret", ".example.com")
	c.SameSite, c.Secure = "None", true
	p1.jar.apply(nil, goCookieMap(c))
	v := "1"
	p1.storage.set("https://example.com", "k", &v)
	if len(g.goCookies.cookies) != 0 || len(g.goStorage.items("https://example.com")) != 0 {
		t.Fatal("the account's jar or storage got a private tab's")
	}
	release1()
	release1() // (once only)
	if !g.goPrivates.has("s1") || len(p1.jar.cookies) != 1 {
		t.Fatal("released while a private tab still holds it")
	}
	release2()
	if g.goPrivates.has("s1") {
		t.Fatal("kept after the session's last private tab")
	}
	if len(p1.jar.cookies) != 0 || len(p1.storage.items("https://example.com")) != 0 {
		t.Fatal("a private jar's cookies or storage outlived it")
	}
	if p3, release3 := g.goPrivates.privateFor("s1"); p3 == p1 || len(p3.jar.cookies) != 0 {
		t.Fatal("a new private tab got the last private jar")
	} else {
		release3()
	}

	// A restart: kept for the tabs to come back to, then let go.
	keep := goPrivateKeep
	goPrivateKeep = 50 * time.Millisecond
	defer func() { goPrivateKeep = keep }()
	p4, release4 := g.goPrivates.privateFor("s1")
	g.goPrivates.keepAWhile()
	release4() // its tab ended by the restart
	if p5, release5 := g.goPrivates.privateFor("s1"); p5 != p4 {
		t.Fatal("a restart didn't keep the private jar")
	} else {
		release5()
	}
	waitUntil(t, "the private jar let go after a restart", func() bool { return !g.goPrivates.has("s1") })
}

// A private tab's engine isn't given the shared HTTP cache.
func TestGoPrivateEngineConfig(t *testing.T) {
	cfg := goEngineConfig{engine: "moli", cache: "/var/cache/go"}
	if got := goEngineConfigFor(cfg, true); got.cache != "" || got.engine != "moli" {
		t.Fatalf("private: %+v", got)
	}
	if got := goEngineConfigFor(cfg, false); got.cache != "/var/cache/go" {
		t.Fatalf("not private: %+v", got)
	}
	if cfg.cache != "/var/cache/go" {
		t.Fatal("the server's config changed")
	}
	args := goSandboxArgs("/usr/bin/moli", "/usr/bin/tabtopd", "/tmp/run", "")
	for _, a := range args {
		if a == "/cache" {
			t.Fatal("no cache, yet bound")
		}
	}
}

// What the server fetches for a private tab's page on a tunnel of its own
// is sent none of the account's cookies, and kept apart from what's
// fetched for the others.
func TestGoPrivateFromNoTab(t *testing.T) {
	g := &server{goCookies: newGoCookieJar("", "")}
	c := goTestCookie("sid", "secret", ".example.com")
	c.SameSite, c.Secure = "None", true
	g.goCookies.apply(nil, goCookieMap(c))
	u, _ := url.Parse("https://media.example.com/v.mp4")
	if got := g.goFromNoTab(false).cookies(u); got != "sid=secret" {
		t.Fatalf("the account's tabs: %q", got)
	}
	f := g.goFromNoTab(true)
	if f.cookies != nil || !f.private {
		t.Fatal("a private tab's fetch is sent the account's cookies")
	}
	if goMediaKey("s", u.String(), f) == goMediaKey("s", u.String(), g.goFromNoTab(false)) {
		t.Fatal("a private tab's media download is shared with the others'")
	}
	if goMediaKey("s", u.String(), nil) != goMediaKey("s", u.String(), &goFrom{}) {
		t.Fatal("media keys changed for tabs that aren't private")
	}
}

// Restart and Clear cache reach every tab, private ones too, which the
// account's jar doesn't list.
func TestGoTabsBrowsers(t *testing.T) {
	ts := &goTabs{by: map[string]*goTab{}}
	a, b := &goBrowser{}, &goBrowser{private: true}
	ts.add(&goTab{token: "a", session: "s", b: a, ended: make(chan struct{})})
	ts.add(&goTab{token: "b", session: "s", private: true, b: b, ended: make(chan struct{})})
	got := ts.browsers()
	if len(got) != 2 || !(got[0] == a && got[1] == b || got[0] == b && got[1] == a) {
		t.Fatalf("browsers: %v", got)
	}
}

// Through the route: a private tab is told it's one, has the session's
// private jar, not the account's; its token takes back only a private
// tab, and a tab that isn't private's only one that isn't; its jar is let
// go as it ends.
func TestGoRoutePrivate(t *testing.T) {
	g, url, s := newGoServer(t, "")
	g.goCookies = newGoCookieJar("", "")
	g.goDetachAfter = 5 * time.Second
	ctx := testCtx(t)
	tabOf := func(token any) *goTab {
		ts := g.goTabList()
		ts.mu.Lock()
		defer ts.mu.Unlock()
		tok, _ := token.(string)
		return ts.by[tok]
	}
	tc := openSession(t, ctx, url, s)
	r := tc.request(t, ctx, map[string]any{"type": "go", "private": true})
	if r["ok"] != true || r["private"] != true {
		t.Fatalf("a private tab: %v", r)
	}
	priv := tabOf(r["resume"])
	if priv == nil || !priv.private || !priv.b.private || priv.b.jar == g.goCookies || priv.b.jar == nil {
		t.Fatal("the private tab hasn't its own jar")
	}
	if !g.goPrivates.has(priv.session) {
		t.Fatal("the session's private jar isn't held")
	}
	privToken := r["resume"]
	tc.c.CloseNow()

	// Its token, from a page that isn't private: a new tab, not private.
	tc = openSession(t, ctx, url, s)
	r = tc.request(t, ctx, map[string]any{"type": "go", "resume": privToken})
	if r["ok"] != true || r["resumed"] == true || r["private"] == true {
		t.Fatalf("a private tab's token, not private: %v", r)
	}
	if plain := tabOf(r["resume"]); plain == nil || plain.private || plain.b.jar != g.goCookies {
		t.Fatal("a tab that isn't private hasn't the account's jar")
	}
	plainToken := r["resume"]
	tc.c.CloseNow()
	// That tab's token, from a private page: a new private tab.
	tc = openSession(t, ctx, url, s)
	r = tc.request(t, ctx, map[string]any{"type": "go", "resume": plainToken, "private": true})
	if r["ok"] != true || r["resumed"] == true || r["private"] != true {
		t.Fatalf("a token of a tab that isn't private, from a private page: %v", r)
	}
	if other := tabOf(r["resume"]); other == nil || other.b.jar != priv.b.jar {
		t.Fatal("the session's private tabs don't share their jar")
	}
	sendGo(t, ctx, tc, map[string]any{"op": "close"})
	// The first private tab, taken back by a private page.
	tc = openSession(t, ctx, url, s)
	r = tc.request(t, ctx, map[string]any{"type": "go", "resume": privToken, "private": true})
	if r["ok"] != true || r["resumed"] != true || r["private"] != true {
		t.Fatalf("a private tab taken back: %v", r)
	}
	sendGo(t, ctx, tc, map[string]any{"op": "close"})
	waitUntil(t, "the private jar let go with the last private tab", func() bool { return !g.goPrivates.has(priv.session) })
	tc = openSession(t, ctx, url, s)
	// (Taken back if it's still kept, else a new one: closed either way.)
	tc.request(t, ctx, map[string]any{"type": "go", "resume": plainToken})
	sendGo(t, ctx, tc, map[string]any{"op": "close"})
	waitUntil(t, "every tab closed", func() bool { return len(goEngineRunDirs(t)) == 0 })
}
