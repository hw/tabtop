package main

import (
	"compress/gzip"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func goAdRulesOf(lines ...string) *goAdRules {
	r := newGoAdRules()
	goParseAdList(r, []byte(strings.Join(lines, "\n")))
	return r
}

// TestGoAdRules holds what's blocked to what the rules say, for a page.
func TestGoAdRules(t *testing.T) {
	r := goAdRulesOf(
		"[Adblock Plus 2.0]",
		"! Title: test",
		"||ads.example^",
		"||track.example^$third-party",
		"||own.example^$~third-party",
		"||only.example^$domain=news.example|~sports.news.example",
		"||cdn.ads.example^",
		"@@||ok.ads.example^",
		"||ok.ads.example^$important,domain=strict.example",
		"@@||trusted.example^$document",
		"0.0.0.0 hosts.example",
		"127.0.0.1 localhost",
		"||typed.example^$script",
		"/banner/*",
		"##.ad",
		"news.example##.sponsor",
		"||wild*.example^",
		"bare.example",
	)
	cases := []struct {
		host, page string
		want       bool
	}{
		{"ads.example", "news.example", true},
		{"x.ads.example", "news.example", true},       // a subdomain
		{"ads.example.net", "news.example", false},    // not a subdomain
		{"badads.example", "news.example", false},     // nor a name ending so
		{"ads.example", "ads.example", false},         // the page's own host
		{"ads.example", "", false},                    // no page known
		{"cdn.ads.example", "ads.example", true},      // another host of its site
		{"track.example", "news.example", true},       // third-party
		{"track.example", "www.track.example", false}, // its own site's page
		{"own.example", "news.example", false},        // first-party only
		{"cdn.own.example", "own.example", true},
		{"only.example", "news.example", true},         // for that page
		{"only.example", "www.news.example", true},     // and its subdomains
		{"only.example", "sports.news.example", false}, // but not this one
		{"only.example", "other.example", false},       // nor others
		{"ok.ads.example", "news.example", false},      // an exception
		{"a.ok.ads.example", "news.example", false},    // for its subdomains too
		{"ok.ads.example", "strict.example", true},     // but not over an important rule
		{"ads.example", "trusted.example", false},      // nothing on that page
		{"ads.example", "www.trusted.example", false},  // nor its subdomains
		{"hosts.example", "news.example", true},        // a hosts file's line
		{"localhost", "news.example", false},           // not localhost
		{"typed.example", "news.example", false},       // for scripts only: not by host
		{"ADS.Example.", "News.Example", true},         // case, and a trailing dot
		{"192.0.2.1", "news.example", false},           // an address no rule names
		{"wildcard.example", "news.example", false},    // a pattern: not by host
		{"x.bare.example", "news.example", true},       // a host alone
	}
	for _, c := range cases {
		if got := r.blocked(c.host, c.page); got != c.want {
			t.Errorf("%s on %q: blocked %v, want %v", c.host, c.page, got, c.want)
		}
	}
	// Lines counted: what's held to (by host, by address, what's shown);
	// comments and headers neither.
	if r.supported != 15 || r.unsupported != 0 {
		t.Errorf("rules: %d supported, %d unsupported; want 15 and 0", r.supported, r.unsupported)
	}
	var none *goAdRules
	if none.blocked("ads.example", "news.example") {
		t.Error("no rules blocked something")
	}
}

func TestGoAdExpiry(t *testing.T) {
	for v, want := range map[string]time.Duration{"4 days (update frequency)": 96 * time.Hour, "12 hours": 12 * time.Hour,
		"1 day": 24 * time.Hour, "soon": 0, "0 days": 0, "3 weeks": 0} {
		if got := goAdExpiry(v); got != want {
			t.Errorf("%q: %v, want %v", v, got, want)
		}
	}
	_, expires := goParseAdList(newGoAdRules(), []byte("[Adblock Plus 2.0]\n! Expires: 2 days\n||a.example^\n"))
	if expires != 48*time.Hour {
		t.Errorf("a list's expiry: %v", expires)
	}
}

// goAdServer serves filter lists: text at /list.txt (counting requests,
// answering 304 to its ETag), gzipped at /list.gz, and an empty page.
func goAdServer(t *testing.T, text string) (*httptest.Server, *atomic.Int32) {
	var asked atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/list.txt":
			asked.Add(1)
			if r.Header.Get("If-None-Match") == `"v1"` {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", `"v1"`)
			fmt.Fprint(w, text)
		case "/list.gz":
			w.Header().Set("Content-Encoding", "gzip")
			z := gzip.NewWriter(w)
			fmt.Fprint(z, text)
			z.Close()
		case "/empty":
			fmt.Fprint(w, "<html>not a list</html>")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &asked
}

// TestGoAdBlockLists turns it on, adds a list by address, and has it kept
// across a restart: nothing fetched till it's turned on.
func TestGoAdBlockLists(t *testing.T) {
	srv, asked := goAdServer(t, "[Adblock Plus 2.0]\n! Title: Test list\n||ads.example^\n##.ad\n")
	file := filepath.Join(t.TempDir(), "state", "go-adblock.json")
	a := newGoAdBlock(file, allowAll)
	ctx := context.Background()
	// Off at first, nothing ticked had: nothing's blocked, nor due.
	if a.blocked("ads.example", "news.example", "") || len(a.due(goAdDue)) != 0 {
		t.Fatal("off, but blocking or fetching")
	}
	// The built-in lists can't be reached from a test: turned off.
	for _, id := range []string{"easylist", "easyprivacy"} {
		if err := a.set(ctx, "list-off", id, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	// An added list is had first; one that can't be, or isn't a list, isn't added.
	if err := a.set(ctx, "list-add", "", srv.URL+"/missing", ""); err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("a missing list: %v", err)
	}
	if err := a.set(ctx, "list-add", "", srv.URL+"/empty", ""); err == nil || !strings.Contains(err.Error(), "no rules") {
		t.Errorf("not a list: %v", err)
	}
	if err := a.set(ctx, "list-add", "", "ftp://example.com/list", ""); err == nil {
		t.Error("an ftp list was taken")
	}
	if err := a.set(ctx, "list-add", "", srv.URL+"/list.txt", ""); err != nil {
		t.Fatal(err)
	}
	if err := a.set(ctx, "list-add", "", srv.URL+"/list.txt", ""); err == nil {
		t.Error("the same list added twice")
	}
	if a.blocked("ads.example", "news.example", "") {
		t.Error("blocking while off")
	}
	if err := a.set(ctx, "on", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if !a.blocked("ads.example", "news.example", "") {
		t.Error("on, the list's host isn't blocked")
	}
	report := a.report()
	lists := report["lists"].([]map[string]any)
	added := lists[len(lists)-1]
	if added["name"] != "Test list" || added["rules"] != 2 || added["unsupported"] != 0 || added["had"] != true || report["rules"] != 2 {
		t.Errorf("the report: %v", report)
	}
	id := added["id"].(string)
	if _, err := os.Stat(filepath.Join(filepath.Dir(file), "go-filters", id+".txt")); err != nil {
		t.Errorf("the list wasn't kept beside the settings: %v", err)
	}
	// Update now: asked again, found unchanged (its ETag).
	before := asked.Load()
	if err := a.updateAll(ctx, goAdAll); err != nil {
		t.Fatal(err)
	}
	if asked.Load() != before+1 || !a.blocked("ads.example", "news.example", "") {
		t.Errorf("updated: asked %d times more, still blocked %v", asked.Load()-before, a.blocked("ads.example", "news.example", ""))
	}
	// Not due again till a day's gone by.
	if due := a.due(goAdDue); len(due) != 0 {
		t.Errorf("due at once: %v", due)
	}
	// Kept: read again as it was.
	b := newGoAdBlock(file, allowAll)
	if !b.blocked("ads.example", "news.example", "") || b.report()["interval"] != "daily" {
		t.Error("not kept across a restart")
	}
	// Off: nothing blocked; the list ticked off: nothing either.
	if err := b.set(ctx, "list-off", id, "", ""); err != nil || b.blocked("ads.example", "news.example", "") {
		t.Errorf("list off: %v, blocked %v", err, b.blocked("ads.example", "news.example", ""))
	}
	if err := b.set(ctx, "list-remove", "easylist", "", ""); err == nil {
		t.Error("a built-in list removed")
	}
	if err := b.set(ctx, "list-remove", id, "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(file), "go-filters", id+".txt")); err == nil {
		t.Error("a removed list's copy is still kept")
	}
	if err := b.set(ctx, "weekly", "", "", ""); err != nil || b.report()["interval"] != "weekly" {
		t.Errorf("weekly: %v", err)
	}
	if err := b.set(ctx, "hourly", "", "", ""); err == nil {
		t.Error("an unknown setting taken")
	}
}

// TestGoAdBlockFetching holds a list's download to where fetches may go,
// its size, and gzip.
func TestGoAdBlockFetching(t *testing.T) {
	srv, _ := goAdServer(t, "||ads.example^\n")
	ctx := context.Background()
	// From this machine: not, by the remote browser's policy.
	a := newGoAdBlock("", fetchPolicy(true))
	if err := a.set(ctx, "list-add", "", srv.URL+"/list.txt", ""); err == nil || !strings.Contains(err.Error(), "this machine") {
		t.Errorf("a list from loopback: %v", err)
	}
	// Gzipped, decoded; kept in memory without a file.
	a = newGoAdBlock("", allowAll)
	a.set(ctx, "on", "", "", "")
	if err := a.set(ctx, "list-add", "", srv.URL+"/list.gz", ""); err != nil {
		t.Fatal(err)
	}
	if !a.blocked("ads.example", "news.example", "") {
		t.Error("a gzipped list's host isn't blocked")
	}
	// Too large.
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		line := strings.Repeat("||a.example^\n", 1000)
		for n := 0; n <= maxGoAdListBytes; n += len(line) {
			fmt.Fprint(w, line)
		}
	}))
	defer big.Close()
	if err := a.set(ctx, "list-add", "", big.URL+"/big.txt", ""); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("a list too large: %v", err)
	}
}

// TestGoAdBlockDue says which lists are had as time goes by.
func TestGoAdBlockDue(t *testing.T) {
	a := newGoAdBlock("", allowAll)
	a.enabled = true
	l := a.list("easylist")
	if due := a.due(goAdDue); len(due) != 2 {
		t.Errorf("never had: due %v", due)
	}
	l.text = []byte("||a.example^")
	l.Updated, l.Tried = time.Now().Add(-23*time.Hour), time.Now().Add(-23*time.Hour)
	if due := a.due(goAdDue); len(due) != 1 || due[0] != "easyprivacy" {
		t.Errorf("had 23 hours ago: due %v", due)
	}
	l.Expires = int64((4 * time.Hour) / time.Second) // says it lasts less: kept 12 hours anyway
	if due := a.due(goAdDue); len(due) != 2 {
		t.Errorf("past its expiry: due %v", due)
	}
	a.interval = "manual"
	if due := a.due(goAdDue); len(due) != 1 {
		t.Errorf("manual: due %v (only what was never had)", due)
	}
	// Tried and failed just now: not again till goAdRetry; asked for, at once.
	e := a.list("easyprivacy")
	e.Tried, e.Error = time.Now(), "failed"
	if due := a.due(goAdDue); len(due) != 0 {
		t.Errorf("just failed: due %v", due)
	}
	if due := a.due(goAdMissing); len(due) != 1 || due[0] != "easyprivacy" {
		t.Errorf("ticked again: due %v", due)
	}
	a.enabled = false
	if due := a.due(goAdAll); len(due) != 0 {
		t.Errorf("off: due %v", due)
	}
}

// TestGoProxyRefusesAds refuses an ad's host for the page the engine's at,
// CONNECT and plain requests alike, but not the page's own, nor anything
// before a page is known.
func TestGoProxyRefusesAds(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") }))
	defer site.Close()
	host := strings.TrimPrefix(site.URL, "http://")
	before := goAdBlocked
	goAdBlocked = goAdRulesOf("||127.0.0.1^").blocked
	defer func() { goAdBlocked = before }()
	p := newGoProxy(allowAll, "", "")
	p.ports = map[string]bool{portOf(t, site.URL): true}
	client, addr := startGoProxy(t, p, "", "")
	get := func() (int, string) {
		res, err := client.Get(site.URL)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode, res.Header.Get(goRefusedHeader)
	}
	if code, _ := get(); code != 200 {
		t.Errorf("no page known: %d", code)
	}
	p.setPage("127.0.0.1")
	if code, _ := get(); code != 200 {
		t.Errorf("the page's own host: %d", code)
	}
	p.setPage("news.example")
	if code, why := get(); code != http.StatusForbidden || why != "ads" {
		t.Errorf("an ad's host: %d %q", code, why)
	}
	if code := connect(t, addr, host, ""); code != http.StatusForbidden {
		t.Errorf("CONNECT to an ad's host: %d", code)
	}
	var none *goProxy
	none.setPage("x") // a tab without a proxy: nothing
}

// TestGoAdMyFilters keeps the person's own rules, reads a host alone as
// ||host^, and says which lines can't be used.
func TestGoAdMyFilters(t *testing.T) {
	a := newGoAdBlock("", allowAll)
	ctx := context.Background()
	text := "! mine\r\nplain.example\n||mine.example^\n@@||ok.plain.example^\n/ads[0-9]+/\nexample.com##.ad\n"
	if err := a.set(ctx, "filters", "", "", text); err != nil {
		t.Fatal(err)
	}
	if a.blocked("plain.example", "news.example", "") {
		t.Error("blocked while ad blocking's off")
	}
	a.set(ctx, "on", "", "", "")
	for host, want := range map[string]bool{"plain.example": true, "x.plain.example": true, "mine.example": true, "ok.plain.example": false, "other.example": false} {
		if got := a.blocked(host, "news.example", ""); got != want {
			t.Errorf("%s: blocked %v, want %v", host, got, want)
		}
	}
	report := a.report()
	problems := report["filterProblems"].([]map[string]any)
	if report["filters"] != strings.ReplaceAll(text, "\r\n", "\n") || len(problems) != 1 || problems[0]["line"] != 5 || problems[0]["text"] != "/ads[0-9]+/" {
		t.Errorf("the report: %v, %v", report["filters"], problems)
	}
	if err := a.set(ctx, "filters", "", "", strings.Repeat("x", maxGoAdFilters+1)); err == nil {
		t.Error("too much taken")
	}
}

// TestGoAdSitePolicy holds a site's own setting over the default, either
// way.
func TestGoAdSitePolicy(t *testing.T) {
	a := newGoAdBlock("", allowAll)
	ctx := context.Background()
	a.set(ctx, "filters", "", "", "||ads.example^")
	for _, c := range []struct {
		on     bool
		policy string
		want   bool
	}{{false, "", false}, {true, "", true}, {true, "allow", false}, {false, "block", true}, {true, "block", true}} {
		setting := "off"
		if c.on {
			setting = "on"
		}
		a.set(ctx, setting, "", "", "")
		if got := a.blocked("ads.example", "news.example", c.policy); got != c.want {
			t.Errorf("on %v, the site's %q: blocked %v, want %v", c.on, c.policy, got, c.want)
		}
	}
	// The site's setting, kept by site: a subdomain's page has it too.
	s := newGoSiteSettings("")
	if s.adsFor("news.example") != "" || s.adsBlocked() {
		t.Error("a setting at first")
	}
	if err := s.set("www.news.example", "ads-allow"); err != nil {
		t.Fatal(err)
	}
	if s.adsFor("sports.news.example") != "allow" || s.adsFor("other.example") != "" {
		t.Errorf("allowed: %q, %q", s.adsFor("sports.news.example"), s.adsFor("other.example"))
	}
	s.set("news.example", "ads-block")
	if !s.adsBlocked() || s.report()["ads"].(map[string]string)["news.example"] != "block" {
		t.Error("blocked, but not said")
	}
	s.set("news.example", "ads-default")
	if s.adsFor("news.example") != "" {
		t.Error("back to the default, but still set")
	}
}

// TestGoAdHideRules reads element hiding rules: keyed by the class or id
// they need, for sites, excepted, and refused when they're more than a
// selector.
func TestGoAdHideRules(t *testing.T) {
	for sel, want := range map[string]string{".ad": ".ad", "#banner > a": "#banner", "ins.adsbygoogle": ".adsbygoogle",
		"div[class^=\"ad\"]": "", "a[href*=\".ad\"]": "", "div > .ad": "", ".ad:not(.x)": ".ad", "#ad_1.big": "#ad_1"} {
		if got := goAdSelectorKey(sel); got != want {
			t.Errorf("the key of %q: %q, want %q", sel, got, want)
		}
	}
	r := goAdRulesOf(
		"##.ad",
		"##.sponsor, #promo",
		"##div[id^=\"div-gpt-ad\"]",
		"news.example##.native",
		"news.example,~sports.news.example##.partner",
		"~quiet.example##.loud",
		"news.example#@#.ad",
		"#@#.sponsor",
		"##.x { color: red }",
		"##.x;background:url(http://evil.example/)",
		"##@import url(x)",
		"##.y:has-text(Sponsored)",
		"example.*##.entity",
		"news.example#?#.z:-abp-has(.ad)",
		"news.example##+js(set-constant, x, 1)",
		"@@||nohide.example^$elemhide",
		"@@||nogeneric.example^$generichide",
		"@@||allowed.example^$document",
	)
	if r.hide.count != 7 {
		t.Errorf("%d selectors kept, want 7", r.hide.count)
	}
	shown := func(page string, classes ...string) []string {
		h := r.hider(page)
		if h == nil {
			return nil
		}
		out := h.start()
		for _, c := range classes {
			out = h.see(out, c)
		}
		slices.Sort(out)
		return out
	}
	cases := []struct {
		page    string
		classes []string
		want    []string
	}{
		{"other.example", []string{".ad", ".sponsor", "#promo", ".native"}, []string{"#promo", ".ad", "div[id^=\"div-gpt-ad\"]"}},
		{"other.example", nil, []string{"div[id^=\"div-gpt-ad\"]"}}, // no class or id it needs
		{"news.example", []string{".ad", ".loud"}, []string{".loud", ".native", ".partner", "div[id^=\"div-gpt-ad\"]"}},
		{"www.news.example", nil, []string{".native", ".partner", "div[id^=\"div-gpt-ad\"]"}},
		{"sports.news.example", nil, []string{".native", "div[id^=\"div-gpt-ad\"]"}},
		{"quiet.example", []string{".loud"}, []string{"div[id^=\"div-gpt-ad\"]"}},
		{"nogeneric.example", []string{".ad"}, []string{}},
		{"nohide.example", []string{".ad"}, nil},
		{"allowed.example", []string{".ad"}, nil},
	}
	for _, c := range cases {
		if got := shown(c.page, c.classes...); !slices.Equal(got, c.want) {
			t.Errorf("on %s with %v: %q, want %q", c.page, c.classes, got, c.want)
		}
	}
	// Each selector once; a page's classes and ids from its tree, not an
	// embedded page's.
	h := r.hider("other.example")
	h.start()
	doc := &goNode{Kids: []*goNode{{Attrs: []string{"class", "x ad"}}, {Base: "https://ads.example/", Kids: []*goNode{{Attrs: []string{"id", "promo"}}}}}}
	if got := h.seeNode(nil, doc); !slices.Equal(got, []string{".ad"}) {
		t.Errorf("from the tree: %q", got)
	}
	if got := h.seeAttr(nil, "class", "ad"); got != nil {
		t.Errorf("given twice: %q", got)
	}
	if got := h.seeAttr(nil, "id", "promo"); !slices.Equal(got, []string{"#promo"}) {
		t.Errorf("an id set later: %q", got)
	}
	var none *goAdRules
	if none.hider("x.example") != nil {
		t.Error("a hider with no rules")
	}
}

// TestGoAdGlob holds patterns to what lists mean by them: * anything, ^ a
// separator or the end.
func TestGoAdGlob(t *testing.T) {
	for _, c := range []struct {
		p, s string
		end  bool
		want bool
	}{
		{"/banner/", "/banner/x.png", false, true},
		{"/banner/*.gif", "/banner/a/b.gif", false, true},
		{"/banner/*.gif", "/banner/a/b.png", false, false},
		{"ads^", "ads/x", false, true},
		{"ads^", "ads", false, true},
		{"ads^", "ads.js", false, false}, // . isn't a separator
		{"ads^", "adsx", false, false},
		{"a*b*c", "axxbyyc", true, true},
		{"a*b*c", "axxbyycz", true, false},
		{".js", "x.js", false, false}, // from the start only (anchoring is the caller's)
	} {
		if got := goAdGlob(c.p, c.s, c.end); got != c.want {
			t.Errorf("%q on %q (end %v): %v, want %v", c.p, c.s, c.end, got, c.want)
		}
	}
}

// TestGoAdURLRules holds requests by their addresses and kinds to rules
// for them.
func TestGoAdURLRules(t *testing.T) {
	r := goAdRulesOf(
		"/banner/*",
		"||ads.example/serve/",
		"|https://tracker.example/pixel",
		"&adunit=",
		"||cdn.example^$script,third-party",
		"||cdn.example/ok.js",
		"@@||cdn.example/ok.js",
		"/ad.js$script,domain=news.example|~sports.news.example",
		"||track.example^",
		"@@||track.example/allowed/$image",
		"||strict.example/x^$important",
		"@@||strict.example/x",
		"||framed.example^$subdocument",
		"/Promo/*$match-case",
		"/regex[0-9]+/",
		"||csp.example^$csp=script-src 'none'",
		"*$popup",
	)
	if r.unsupported != 3 {
		t.Errorf("%d not usable, want 3 (a regular expression, $csp, $popup)", r.unsupported)
	}
	cases := []struct {
		url, kind, page string
		want            bool
	}{
		{"https://news.example/img/banner/1.png", "image", "news.example", true},
		{"https://news.example/img/banners/1.png", "image", "news.example", false},
		{"https://ads.example/serve/x", "script", "news.example", true},
		{"https://cdn.ads.example/serve/x", "script", "news.example", true}, // a subdomain
		{"https://badads.example/serve/x", "script", "news.example", false},
		{"https://tracker.example/pixel.gif", "image", "news.example", true},
		{"https://x.example/?id=1&adunit=top", "xhr", "news.example", true},
		{"https://cdn.example/lib.js", "script", "news.example", true},
		{"https://cdn.example/lib.css", "css", "news.example", false},  // scripts only
		{"https://cdn.example/lib.js", "script", "cdn.example", false}, // its own site
		{"https://cdn.example/ok.js", "script", "news.example", false}, // an exception
		{"https://x.example/ad.js", "script", "news.example", true},
		{"https://x.example/ad.js", "script", "sports.news.example", false},
		{"https://x.example/ad.js", "image", "news.example", false},
		{"https://track.example/anything", "xhr", "news.example", true}, // the host's rule, by address too
		{"https://track.example/allowed/p.png", "image", "news.example", false},
		{"https://track.example/allowed/p.js", "script", "news.example", true}, // the exception's for images only
		{"https://strict.example/x/1", "script", "news.example", true},         // important
		{"https://framed.example/", "subdocument", "news.example", true},
		{"https://framed.example/a.js", "script", "news.example", false},
		{"https://x.example/Promo/a", "image", "news.example", true},
		{"https://x.example/promo/a", "image", "news.example", false},
	}
	kinds := map[string]uint16{"image": goAdTImage, "script": goAdTScript, "css": goAdTStylesheet, "xhr": goAdTXHR, "subdocument": goAdTSubdocument}
	for _, c := range cases {
		if got, _ := r.blockedURL(c.url, kinds[c.kind], c.page); got != c.want {
			t.Errorf("%s (%s) on %s: blocked %v, want %v", c.url, c.kind, c.page, got, c.want)
		}
	}
	if _, byHost := r.blockedURL("https://track.example/a", goAdTXHR, "news.example"); !byHost {
		t.Error("a host's rule not said to be the host's")
	}
	// The proxy, which sees hosts only, leaves alone hosts with exceptions
	// by address: refusing them whole would undo the exceptions.
	if !r.urlExcepted("track.example") || !r.urlExcepted("a.cdn.example") || r.urlExcepted("ads.example") {
		t.Errorf("hosts with exceptions: %v", r.urlExceptHosts)
	}
	// Kept by a word, mostly.
	if n := len(r.urlBlock.rest); n > 2 {
		t.Errorf("%d rules tried for every request", n)
	}
}
