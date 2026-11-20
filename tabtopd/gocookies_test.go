package main

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func goTestCookie(name, value, domain string) goCookie {
	return goCookie{Name: name, Value: value, Domain: domain, Path: "/", Expires: 2_000_000_000} // 2033: after the tests' clocks
}

func goCookieMap(list ...goCookie) map[goCookieKey]goCookie {
	m := map[goCookieKey]goCookie{}
	for _, c := range list {
		m[c.key()] = c
	}
	return m
}

// A tab's changes are taken as changes from what it had: new and changed
// cookies kept, those it dropped removed, and those it never touched (a
// cookie another tab set, or the settings cleared) left as the jar has them.
func TestGoCookieJarApply(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	j := newGoCookieJar("", "")
	j.now = func() time.Time { return clock }

	a, b := goTestCookie("a", "1", ".example.com"), goTestCookie("b", "2", "www.example.com")
	if n := j.apply(nil, goCookieMap(a, b)); n != 2 {
		t.Fatalf("new: %d changed", n)
	}
	first := j.cookies[a.key()].Changed

	// The same, its expiry renewed later: not set anew.
	clock = clock.Add(time.Hour)
	a2 := a
	a2.Expires += 3600
	j.apply(goCookieMap(a, b), goCookieMap(a2, b))
	if got := j.cookies[a.key()]; got.Changed != first || got.Expires != a2.Expires {
		t.Errorf("renewed: changed %d (was %d), expires %v", got.Changed, first, got.Expires)
	}
	// A new value: set now.
	a3 := a2
	a3.Value = "one"
	j.apply(goCookieMap(a2, b), goCookieMap(a3, b))
	if got := j.cookies[a.key()]; got.Changed != clock.UnixMilli() || got.Value != "one" {
		t.Errorf("changed value: %+v", got)
	}

	// A tab that last had b removes it: gone. Another tab, whose b was
	// replaced meanwhile by a third, doesn't take the newer one away.
	j.apply(goCookieMap(a3, b), goCookieMap(a3))
	if _, ok := j.cookies[b.key()]; ok {
		t.Error("b kept after the tab removed it")
	}
	c := goTestCookie("c", "new", ".example.org")
	j.apply(nil, goCookieMap(c))
	old := c
	old.Value = "old"
	j.apply(goCookieMap(old), goCookieMap())
	if _, ok := j.cookies[c.key()]; !ok {
		t.Error("a cookie another tab has set anew was removed by one that had its older value")
	}

	// Expired ones, and oversized ones, aren't kept.
	gone := goTestCookie("gone", "x", ".example.com")
	gone.Expires = float64(clock.Add(-time.Minute).Unix())
	big := goTestCookie("big", strings.Repeat("x", maxGoCookieValue), ".example.com")
	j.apply(nil, goCookieMap(gone, big))
	if _, ok := j.cookies[gone.key()]; ok {
		t.Error("an expired cookie was kept")
	}
	if _, ok := j.cookies[big.key()]; ok {
		t.Error("an oversized cookie was kept")
	}
}

// Forgetting: a site's cookies (by its registrable domain), or those set
// since a time.
func TestGoCookieJarForget(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	j := newGoCookieJar("", "")
	j.now = func() time.Time { return clock }
	j.apply(nil, goCookieMap(goTestCookie("a", "1", ".example.co.uk"), goTestCookie("b", "1", "shop.example.co.uk"), goTestCookie("c", "1", "other.com")))
	clock = clock.Add(2 * time.Hour)
	j.apply(nil, goCookieMap(goTestCookie("d", "1", "late.com")))

	sites := j.sites(nil)
	if len(sites) != 3 || sites[0].Site != "example.co.uk" || sites[0].Cookies != 2 {
		t.Fatalf("sites %+v", sites)
	}
	if n := j.forget("", clock.Add(-time.Hour)); n != 1 {
		t.Errorf("the last hour: %d forgotten", n)
	}
	if _, ok := j.cookies[goCookieKey{"c", "other.com", "/"}]; !ok {
		t.Error("an older cookie went with the last hour's")
	}
	if n := j.forget("example.co.uk", time.Time{}); n != 2 {
		t.Errorf("the site: %d forgotten", n)
	}
	if n := j.forget("", time.Time{}); n != 1 || len(j.cookies) != 0 {
		t.Errorf("all: %d forgotten, %d left", n, len(j.cookies))
	}
}

// Kept sealed: read back as it was, session cookies not kept, and a file
// that can't be read set aside rather than overwritten.
func TestGoCookieJarSealed(t *testing.T) {
	dir := t.TempDir()
	file, keyFile := filepath.Join(dir, "cookies"), filepath.Join(dir, "key")
	j := newGoCookieJar(file, keyFile)
	session := goTestCookie("s", "1", "example.com")
	session.Session, session.Expires = true, -1
	j.apply(nil, goCookieMap(goTestCookie("k", "secret-value", ".example.com"), session))
	j.save()
	data, err := os.ReadFile(file)
	if err != nil || strings.Contains(string(data), "secret-value") || strings.Contains(string(data), "example.com") {
		t.Fatalf("not sealed: %v %q", err, data)
	}
	again := newGoCookieJar(file, keyFile)
	if len(again.cookies) != 1 || again.cookies[goCookieKey{"k", ".example.com", "/"}] == nil {
		t.Fatalf("read back %d", len(again.cookies))
	}
	// Another key: it can't be read; set aside, a new jar begun.
	os.WriteFile(keyFile, make([]byte, 32), 0o600)
	other := newGoCookieJar(file, keyFile)
	if len(other.cookies) != 0 || other.file == "" {
		t.Fatalf("an unreadable jar: %d cookies, file %q", len(other.cookies), other.file)
	}
	if aside, _ := filepath.Glob(file + ".broken-*"); len(aside) != 1 {
		t.Errorf("not set aside: %v", aside)
	}
}

// Given to an engine by a URL of its host: a host-only cookie without a
// domain (else it'd be sent to the host's subdomains too).
func TestGoCookieImportParams(t *testing.T) {
	host := goTestCookie("h", "1", "www.example.com")
	host.Secure, host.HTTPOnly, host.SameSite = true, true, "Lax"
	p := host.importParams()
	if p["url"] != "https://www.example.com/" || p["domain"] != nil || p["httpOnly"] != true || p["sameSite"] != "Lax" {
		t.Errorf("host-only: %v", p)
	}
	dom := goTestCookie("d", "1", ".example.com")
	dom.Session, dom.Expires = true, -1
	p = dom.importParams()
	if p["url"] != "http://example.com/" || p["domain"] != ".example.com" || p["expires"] != nil {
		t.Errorf("domain, session: %v", p)
	}
}

func TestGoSiteAndOrigin(t *testing.T) {
	for host, want := range map[string]string{"www.bbc.co.uk": "bbc.co.uk", "example.com": "example.com", "127.0.0.1": "127.0.0.1", "localhost": "localhost", "A.Example.COM.": "example.com"} {
		if got := goSite(host); got != want {
			t.Errorf("goSite(%q) = %q, want %q", host, got, want)
		}
	}
	for raw, want := range map[string]string{"https://WWW.example.com/a?b#c": "https://www.example.com", "http://h:8080/x": "http://h:8080", "file:///x": "", "https://u@h/": "", "about:blank": ""} {
		if got := goOrigin(raw); got != want {
			t.Errorf("goOrigin(%q) = %q, want %q", raw, got, want)
		}
	}
	if goOriginHost("http://h:8080") != "h" || goOriginHost("https://www.example.com") != "www.example.com" {
		t.Error("goOriginHost")
	}
}

// What goes with media fetched for a page: the cookies for its address
// (host-only to its host alone, a domain cookie to subdomains, by path,
// secure over https), SameSite ones only from a page of the same site.
func TestGoMediaCookieHeader(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	j := newGoCookieJar("", "")
	j.now = func() time.Time { return clock }
	mk := func(name, domain, path, sameSite string, secure bool) goCookie {
		c := goTestCookie(name, name+"v", domain)
		c.Path, c.SameSite, c.Secure = path, sameSite, secure
		return c
	}
	j.apply(nil, goCookieMap(
		mk("host", "video.example.com", "/", "Lax", false),
		mk("dom", ".example.com", "/", "None", true),
		mk("deep", ".example.com", "/v/clips", "None", true),
		mk("nopath", ".example.com", "/v/cl", "None", true), // /v/clips isn't under /v/cl
		mk("plain", ".example.com", "/", "None", false),     // None without Secure: not sent
		mk("other", "cdn.example.com", "/", "Lax", false),
	))
	u, _ := url.Parse("https://video.example.com/v/clips/1.mp4")
	if got := j.header(u, "example.com"); got != "deep=deepv; host=hostv; dom=domv" && got != "deep=deepv; dom=domv; host=hostv" {
		t.Errorf("from the site's own page: %q", got)
	}
	if got := j.header(u, "other.org"); got != "deep=deepv; dom=domv" {
		t.Errorf("from another site's page: %q", got)
	}
	if got := j.header(u, ""); got != "deep=deepv; dom=domv" {
		t.Errorf("from no page known: %q", got)
	}
	plain, _ := url.Parse("http://video.example.com/x")
	if got := j.header(plain, "example.com"); got != "host=hostv" {
		t.Errorf("over http: %q", got)
	}
	// At most goCookieHeaderMax.
	var many []goCookie
	for i := 0; i < 100; i++ {
		many = append(many, goCookie{Name: "n" + strings.Repeat("x", 100), Value: strings.Repeat("v", 200), Path: "/"})
	}
	if len(goCookieHeader(many)) > goCookieHeaderMax {
		t.Error("the header is over its limit")
	}
}

// The Referer a page's fetches send, as a browser's default policy has it.
func TestGoReferrer(t *testing.T) {
	for _, c := range []struct{ page, to, want string }{
		{"https://www.example.com/a/b?q=1#frag", "https://www.example.com/pic.png", "https://www.example.com/a/b?q=1"}, // its own origin: the page
		{"https://www.example.com/a/b?q=1", "https://cdn.example.net/pic.png", "https://www.example.com/"},             // another: its origin
		{"https://www.example.com/a", "http://www.example.com/pic.png", ""},                                            // https to http: nothing
		{"http://www.example.com/a", "https://cdn.example.net/p.png", "http://www.example.com/"},                       // http to https: the origin
		{"https://user:pw@www.example.com/a", "https://www.example.com/p.png", "https://www.example.com/a"},            // never a password
		{"", "https://cdn.example.net/p.png", ""}, {"about:blank", "https://cdn.example.net/p.png", ""},
	} {
		u, _ := url.Parse(c.to)
		if got := goReferrer(c.page, u); got != c.want {
			t.Errorf("%q to %q: %q, want %q", c.page, c.to, got, c.want)
		}
	}
	// Applied anew to each address: what one had doesn't go to the next.
	f := &goFrom{cookies: func(u *url.URL) string {
		if u.Host == "a.example" {
			return "k=v"
		}
		return ""
	}, referer: func(u *url.URL) string { return goReferrer("https://a.example/page", u) }}
	r, _ := http.NewRequest("GET", "https://a.example/x", nil)
	f.apply(r)
	if r.Header.Get("Cookie") != "k=v" || r.Header.Get("Referer") != "https://a.example/page" {
		t.Errorf("first: %v", r.Header)
	}
	r.URL, _ = url.Parse("http://b.example/y")
	f.apply(r)
	if r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" {
		t.Errorf("redirected to another, insecure: %v", r.Header)
	}
	var none *goFrom
	r.Header.Set("Cookie", "x=y")
	none.apply(r)
	if r.Header.Get("Cookie") != "" {
		t.Error("nil left a cookie")
	}
}
