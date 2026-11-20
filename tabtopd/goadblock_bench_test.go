package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// goAdBenchRules are about as many rules as EasyList and EasyPrivacy have
// by host together: plain ones, third-party ones, some for a few sites'
// pages ($domain=, as long as lists' get), and exceptions.
func goAdBenchRules() *goAdRules {
	var lines []string
	for i := range 60000 {
		lines = append(lines, fmt.Sprintf("||ad%d.net%d.example%d.com^", i, i%997, i%13))
	}
	for i := range 4000 {
		lines = append(lines, fmt.Sprintf("||track%d.example.org^$third-party", i))
	}
	for i := range 1000 {
		var domains []string
		for j := range 40 {
			domains = append(domains, fmt.Sprintf("site%d.example", (i*40+j)%5000))
		}
		lines = append(lines, fmt.Sprintf("||widget%d.example.net^$domain=%s", i, strings.Join(domains, "|")))
	}
	for i := range 500 {
		lines = append(lines, fmt.Sprintf("@@||ok.ad%d.net%d.example%d.com^", i, i%997, i%13))
	}
	r := newGoAdRules()
	goParseAdList(r, []byte(strings.Join(lines, "\n")))
	return r
}

// goAdBenchRequests are what a few pages ask for: mostly their own and
// common sites' hosts (not blocked), some ads and trackers, a host often
// asked for again and again, as pages do.
func goAdBenchRequests() [][2]string {
	var reqs [][2]string
	for p := range 20 {
		page := fmt.Sprintf("www.site%d.example", p*7)
		for i := range 60 {
			var host string
			switch i % 6 {
			case 0:
				host = fmt.Sprintf("x.ad%d.net%d.example%d.com", i*31, (i*31)%997, (i*31)%13) // blocked
			case 1:
				host = fmt.Sprintf("track%d.example.org", i) // blocked, third-party
			case 2:
				host = fmt.Sprintf("widget%d.example.net", i) // blocked on some pages
			case 3:
				host = fmt.Sprintf("img%d.cdn.static.deep.subdomain.example.co.uk", i%5)
			default:
				host = fmt.Sprintf("static.site%d.example", p*7) // its own site
			}
			reqs = append(reqs, [2]string{host, page})
		}
	}
	return reqs
}

func BenchmarkGoAdBlocked(b *testing.B) {
	r := goAdBenchRules()
	reqs := goAdBenchRequests()
	b.ReportAllocs()
	b.ResetTimer()
	for i := range b.N {
		q := reqs[i%len(reqs)]
		r.blocked(q[0], q[1])
	}
}

func BenchmarkGoAdParse(b *testing.B) {
	var lines []string
	for i := range 60000 {
		lines = append(lines, fmt.Sprintf("||ad%d.net%d.example%d.com^", i, i%997, i%13))
	}
	data := []byte(strings.Join(lines, "\n"))
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		goParseAdList(newGoAdRules(), data)
	}
}

// BenchmarkGoAdDecide is a decision worked out, without what's been
// decided before (goAdCache): a host asked for the first time.
func BenchmarkGoAdDecide(b *testing.B) {
	r := goAdBenchRules()
	reqs := goAdBenchRequests()
	b.ReportAllocs()
	b.ResetTimer()
	for i := range b.N {
		q := reqs[i%len(reqs)]
		r.decide(q[0], q[1])
	}
}

// goAdRealLists are filter lists to measure with, if GO_ADBLOCK_LISTS
// names their folder (EasyList's and EasyPrivacy's, say); skipped if not.
func goAdRealLists(b *testing.B) *goAdRules {
	dir := os.Getenv("GO_ADBLOCK_LISTS")
	if dir == "" {
		b.Skip("GO_ADBLOCK_LISTS names no folder of lists")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.txt"))
	r := newGoAdRules()
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			b.Fatal(err)
		}
		goParseAdList(r, data)
	}
	b.Logf("%d lists: %d rules used, %d not; %d hiding selectors, %d needing no class or id", len(files), r.supported, r.unsupported, r.hide.count, len(r.hide.unkeyed))
	return r
}

func BenchmarkGoAdRealParse(b *testing.B) {
	goAdRealLists(b)
	dir := os.Getenv("GO_ADBLOCK_LISTS")
	files, _ := filepath.Glob(filepath.Join(dir, "*.txt"))
	var all [][]byte
	for _, f := range files {
		data, _ := os.ReadFile(f)
		all = append(all, data)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		r := newGoAdRules()
		for _, data := range all {
			goParseAdList(r, data)
		}
	}
}

// BenchmarkGoAdRealHide is what a page with 300 classes and ids, some an
// ad's, is given to hide.
func BenchmarkGoAdRealHide(b *testing.B) {
	r := goAdRealLists(b)
	keys := []string{".adsbygoogle", ".ad-banner", "#ad-slot", ".sponsored", "#taboola-below-article"}
	for i := range 295 {
		keys = append(keys, fmt.Sprintf(".css-%x", i*7919))
	}
	h := r.hider("www.example.com")
	n := len(h.start())
	for _, k := range keys {
		n += len(h.see(nil, k))
	}
	b.Logf("a page's selectors to hide: %d", n)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		h := r.hider("www.example.com")
		out := h.start()
		for _, k := range keys {
			out = h.see(out, k)
		}
	}
}

// BenchmarkGoAdRealURL is a request decided by its address, with the real
// lists: a page's own requests, a CDN's, and ads' and trackers'.
func BenchmarkGoAdRealURL(b *testing.B) {
	r := goAdRealLists(b)
	urls := []string{
		"https://www.example.com/static/js/main.4f3a2b.js",
		"https://www.example.com/api/v2/articles?page=2&sort=new",
		"https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js",
		"https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2",
		"https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-123",
		"https://www.google-analytics.com/g/collect?v=2&tid=G-XYZ&cid=1.2",
		"https://www.example.com/images/banner/ad-300x250.jpg",
		"https://securepubads.g.doubleclick.net/tag/js/gpt.js",
		"https://www.example.com/wp-content/plugins/ads/front.js",
		"https://images.example.com/photos/2026/11/city.jpg?w=800",
	}
	for _, u := range urls {
		blocked, _ := r.blockedURL(u, goAdTScript, "www.example.com")
		b.Logf("%v %s", blocked, u)
	}
	most := 0
	for _, rules := range r.urlBlock.byWord {
		most = max(most, len(rules))
	}
	b.Logf("rules by address: %d words, at most %d a word, %d tried for every request", len(r.urlBlock.byWord), most, len(r.urlBlock.rest))
	b.ReportAllocs()
	b.ResetTimer()
	for i := range b.N {
		r.blockedURL(urls[i%len(urls)], goAdTScript, "www.example.com")
	}
}
