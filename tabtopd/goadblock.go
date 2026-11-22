// The remote browser's ad blocking (go/settings, "Ad blocking" and "Filter
// lists"): filter lists, downloaded when the person asks for them (turning
// blocking on, ticking a list, adding one by its address, Update now) and
// kept up to date after, and the hosts they name refused. Off at first:
// nothing is downloaded until it's turned on.
//
// What a list says is read for what can be held to by host alone, since
// the engine's HTTPS goes through its proxy as CONNECT tunnels, named by
// host only (goproxy.go):
//
//	||ads.example^                  ads.example and its subdomains
//	||ads.example^$third-party      ...on other sites' pages only ($3p)
//	||ads.example^$domain=a.com|~b.a.com   ...on a.com's pages, not b.a.com's
//	@@||cdn.example^                an exception
//	@@||site.example^$document      nothing blocked on site.example's pages
//	0.0.0.0 ads.example             a hosts file's line
//
// Rules for a path, for some kinds of request only ($script, $image...), or
// what's shown (##.ad) can't be held to here; they're counted, as
// "unsupported", and left for later.
//
// A page's own host is never refused, nor anything while the page isn't
// known: going to an ad's site, or following an ad, loads it. The engine's
// proxy knows its page (setPage, from the tab: the document it's asked for,
// before it's fetched, on Moli; the person's navigations; the page shown);
// the server's own fetches for a page (pictures, stylesheets, fonts,
// media) know it from the tab's goFrom.
//
// Kept in -go-adblock-file (the image's ~/.config/tabtop/go-adblock.json),
// the lists beside it in go-filters/; the owner's alone, out of the file
// roots, as the gateway's other state is. Empty: in memory, till a restart.

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxGoAdLists     = 20       // lists, the built-in ones too
	maxGoAdListBytes = 10 << 20 // a list's size, as it's sent and decoded
	goAdListTimeout  = 2 * time.Minute
	// A list that couldn't be had is tried again after goAdRetry; one
	// that says it lasts less than goAdMinExpiry is kept that long.
	goAdRetry     = time.Hour
	goAdMinExpiry = 12 * time.Hour
	goAdCheck     = 30 * time.Minute // how often it looks for lists due
)

// goAdBuiltIn are the lists offered, the first two ticked at first.
var goAdBuiltIn = []goAdList{
	{ID: "easylist", Name: "EasyList", URL: "https://easylist.to/easylist/easylist.txt", On: true},
	{ID: "easyprivacy", Name: "EasyPrivacy", URL: "https://easylist.to/easylist/easyprivacy.txt", On: true},
	{ID: "peterlowe", Name: "Peter Lowe's ad and tracking servers", URL: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext"},
	{ID: "fanboy-annoyance", Name: "Fanboy's Annoyance List", URL: "https://secure.fanboy.co.nz/fanboy-annoyance.txt"},
}

// goAdIntervals are how often lists are updated, by name.
var goAdIntervals = map[string]time.Duration{"daily": 24 * time.Hour, "weekly": 7 * 24 * time.Hour, "manual": 0}

// goAdBlocked is whether a request to host, for a page at pageHost, is an
// ad's or a tracker's to refuse. Nothing, till the settings are read.
var goAdBlocked = func(host, pageHost string) bool { return false }

// --- Rules -------------------------------------------------------------------
//
// Rules are kept by the host they name, in one hash map, and a request is
// decided by looking up its host and each domain above it (a.b.example:
// a.b.example, b.example, example): one lookup a label, whatever the number
// of rules, with every kind of rule for a host (blocking, exceptions) in
// the one entry. A rule with no conditions, most of them, is a flag on its
// entry, not a rule kept. A long $domain= list is a set, looked up by the
// page's host and the domains above it, not read through. What's decided
// is kept (goAdCache), by host and page: a page asks for the same hosts
// again and again.

// goAdRule is one rule's conditions, beyond the host it's filed under.
type goAdRule struct {
	party      int8     // 1: on other sites' pages only; -1: on its own site's only; 0: either
	important  bool     // not undone by an exception
	hide       uint8    // for an exception about hiding: goAdNoGeneric, goAdNoHide
	domains    []string // the pages' hosts it's for (and their subdomains); none: any
	notDomains []string // ...and not for
	// The same, as sets, when they're long enough to be worth it.
	domainSet, notDomainSet map[string]struct{}
}

// goAdDomainSetFrom is how long a $domain= list is before it's kept as a
// set too.
const goAdDomainSetFrom = 8

// goAdEntry is what's said of one host: kept small, as there's one for
// each of tens of thousands of hosts, most of them only blocked.
type goAdEntry struct {
	blockAll bool        // a rule without conditions blocks it
	more     *goAdRuling // any rules with conditions, and exceptions
}

type goAdRuling struct {
	block []goAdRule // rules with conditions
	allow []goAdRule // exceptions
}

// ruling is e's rules with conditions, made if there are none yet.
func (e *goAdEntry) ruling() *goAdRuling {
	if e.more == nil {
		e.more = &goAdRuling{}
	}
	return e.more
}

// goAdRules are a set of lists' rules, by host.
type goAdRules struct {
	hosts     map[string]goAdEntry
	pageAllow map[string][]goAdRule // pages nothing's blocked on ($document exceptions)
	hide      goAdHide              // element hiding
	urlBlock  goAdURLIndex          // rules by address
	urlAllow  goAdURLIndex          // ...their exceptions
	// urlExceptHosts are hosts with exceptions by address (@@||cdn.example/
	// ads.js): not refused whole by the proxy, which can't see addresses.
	urlExceptHosts map[string]bool
	supported      int
	unsupported    int
	cache          goAdCache
}

func newGoAdRules() *goAdRules {
	return &goAdRules{hosts: map[string]goAdEntry{}, pageAllow: map[string][]goAdRule{}}
}

// goAdOptionsIgnored are options that don't change what a host rule
// blocks.
var goAdOptionsIgnored = map[string]bool{"match-case": true, "all": true, "~match-case": true}

// add reads one line of a list into r; it says whether the line was a rule
// at all (not a comment, a header, or blank).
func (r *goAdRules) add(line string) bool {
	line = strings.TrimSpace(line)
	if line == "" || line[0] == '!' || line[0] == '[' || line[0] == '#' && (len(line) < 2 || !strings.ContainsRune("#@?$%", rune(line[1]))) {
		return false // a comment, a header (a hosts file's comments start with #, a space)
	}
	if hiding, ok := r.addHide(line); hiding {
		if ok {
			r.supported++
		} else {
			r.unsupported++
		}
		return true
	}
	if host, ok := goHostsLine(line); ok {
		if host != "" {
			r.blockAll(host)
			r.supported++
		}
		return host != ""
	}
	if goAdHostName(line) {
		// A host alone (uBlock Origin's reading): ||host^.
		r.blockAll(line)
		r.supported++
		return true
	}
	rule, host, kind, ok := goParseAdRule(line)
	if !ok {
		if ur, exception, ok := goParseAdURLRule(line); ok {
			if exception {
				r.urlAllow.add(ur)
				r.noteExceptHost(ur)
			} else {
				r.urlBlock.add(ur)
			}
			r.supported++
			return true
		}
		r.unsupported++
		return true
	}
	r.supported++
	switch {
	case kind == goAdKindPage:
		r.pageAllow[host] = append(r.pageAllow[host], rule)
		r.hidePage(host, goAdNoHide)
	case kind == goAdKindNoHide:
		r.hidePage(host, rule.hide)
	case kind == goAdKindAllow:
		e := r.hosts[host]
		e.ruling().allow = append(e.ruling().allow, rule)
		r.hosts[host] = e
	case rule.party == 0 && !rule.important && rule.domains == nil && rule.notDomains == nil:
		r.blockAll(host)
	default:
		e := r.hosts[host]
		e.ruling().block = append(e.ruling().block, rule)
		r.hosts[host] = e
	}
	return true
}

// noteExceptHost notes the host an exception by address is for, if its
// pattern names one (||cdn.example/ads.js, ||cdn.example^$script).
func (r *goAdRules) noteExceptHost(ur *goAdURLRule) {
	if !ur.hostAnchor {
		return
	}
	p := ur.pattern
	i := 0
	for i < len(p) && (goAdWordByte(p[i]) || p[i] == '.' || p[i] == '-' || p[i] == '_') {
		i++
	}
	if i == len(p) && !ur.end || i < len(p) && p[i] != '/' && p[i] != '^' && p[i] != ':' {
		return
	}
	if h := p[:i]; goAdHostName(h) {
		if r.urlExceptHosts == nil {
			r.urlExceptHosts = map[string]bool{}
		}
		r.urlExceptHosts[h] = true
	}
}

// urlExcepted is whether host, or a domain above it, has exceptions by
// address.
func (r *goAdRules) urlExcepted(host string) bool {
	if r == nil || len(r.urlExceptHosts) == 0 {
		return false
	}
	host = goAdHost(host)
	for s := host; ; {
		if r.urlExceptHosts[s] {
			return true
		}
		i := strings.IndexByte(s, '.')
		if i < 0 || goAdNumeric(host) {
			return false
		}
		s = s[i+1:]
	}
}

// pageAllowed is whether nothing's blocked on m's page ($document).
func (r *goAdRules) pageAllowed(m *goAdMatch) bool {
	numeric := goAdNumeric(m.page)
	for s := m.page; ; {
		if rules := r.pageAllow[s]; rules != nil && m.any(rules) {
			return true
		}
		i := strings.IndexByte(s, '.')
		if i < 0 || numeric {
			return false
		}
		s = s[i+1:]
	}
}

// hidePage marks a site's pages as having no generic hiding, or none.
func (r *goAdRules) hidePage(host string, flags uint8) {
	if r.hide.pages == nil {
		r.hide.pages = map[string]uint8{}
	}
	r.hide.pages[host] |= flags
}

func (r *goAdRules) blockAll(host string) {
	e := r.hosts[host]
	e.blockAll = true
	r.hosts[host] = e
}

// goHostsLine reads a hosts file's line ("0.0.0.0 ads.example"): the host
// it sends nowhere; ok false if it isn't such a line, host "" if it's one
// that names nothing to block (localhost and the like).
func goHostsLine(line string) (host string, ok bool) {
	if c := line[0]; c != '0' && c != '1' && c != ':' {
		return "", false // not without splitting it
	}
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return "", false
	}
	switch fields[0] {
	case "0.0.0.0", "127.0.0.1", "::", "::1":
	default:
		return "", false
	}
	h := strings.ToLower(strings.TrimSuffix(fields[1], "."))
	switch h {
	case "localhost", "localhost.localdomain", "local", "broadcasthost", "0.0.0.0", "ip6-localhost", "ip6-loopback":
		return "", true
	}
	if !goAdHostName(h) {
		return "", true
	}
	return h, true
}

// goAdHostName is whether h is a host name a rule may name: lower-case
// letters, digits, hyphens and underscores, in labels, with at least one
// dot.
func goAdHostName(h string) bool {
	if len(h) > 253 || len(h) < 3 {
		return false
	}
	label, dots := 0, 0 // the label's length so far
	for i := 0; i < len(h); i++ {
		switch c := h[i]; {
		case c == '.':
			if label == 0 {
				return false
			}
			label = 0
			dots++
		case c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_':
			if label++; label > 63 {
				return false
			}
		default:
			return false
		}
	}
	return dots > 0 && label > 0
}

// What a rule is: a block, an exception, or a page's exception.
const (
	goAdKindBlock = iota
	goAdKindAllow
	goAdKindPage
	goAdKindNoHide // what a site's pages have hidden: less, or nothing
)

// goParseAdRule reads a filter rule that's for a whole host: the rule, the
// host, and its kind; ok false if it isn't one that can be held to by host.
func goParseAdRule(line string) (rule goAdRule, host string, kind int, ok bool) {
	if strings.Contains(line, "#") && (strings.Contains(line, "##") || strings.Contains(line, "#@#") || strings.Contains(line, "#?#") ||
		strings.Contains(line, "#$#") || strings.Contains(line, "#%#")) {
		return rule, "", 0, false // what's shown, not what's fetched
	}
	kind = goAdKindBlock
	if strings.HasPrefix(line, "@@") {
		line = line[2:]
		kind = goAdKindAllow
	}
	pattern, options, _ := strings.Cut(line, "$")
	if !strings.HasPrefix(pattern, "||") {
		return rule, "", 0, false
	}
	host = strings.ToLower(pattern[2:])
	for _, end := range []string{"^|", "^", "/"} {
		if strings.HasSuffix(host, end) {
			host = strings.TrimSuffix(host, end)
			break
		}
	}
	if !goAdHostName(host) {
		return rule, "", 0, false
	}
	if options == "" {
		return rule, host, kind, true
	}
	for _, o := range strings.Split(options, ",") {
		o = strings.ToLower(strings.TrimSpace(o))
		name, value, _ := strings.Cut(o, "=")
		switch {
		case goAdOptionsIgnored[o]:
		case o == "third-party" || o == "3p" || o == "~first-party" || o == "~1p":
			rule.party = 1
		case o == "~third-party" || o == "~3p" || o == "first-party" || o == "1p":
			rule.party = -1
		case o == "important":
			rule.important = true
		case name == "domain" || name == "from":
			for _, d := range strings.Split(value, "|") {
				not := strings.HasPrefix(d, "~")
				d = strings.TrimPrefix(d, "~")
				if !goAdHostName(d) {
					return rule, "", 0, false // an entity (example.*), a pattern
				}
				if not {
					rule.notDomains = append(rule.notDomains, d)
				} else {
					rule.domains = append(rule.domains, d)
				}
			}
		case (o == "document" || o == "doc") && kind == goAdKindAllow:
			kind = goAdKindPage
		case (o == "elemhide" || o == "ehide" || o == "generichide" || o == "ghide") && kind != goAdKindBlock:
			if kind == goAdKindAllow {
				kind = goAdKindNoHide
			}
			if o == "elemhide" || o == "ehide" {
				rule.hide |= goAdNoHide
			} else {
				rule.hide |= goAdNoGeneric
			}
		case o == "document" || o == "doc":
			// Blocking a page: its host blocked, as for anything else (a
			// page's own host never is, so going there still loads it).
		default:
			// For some kinds of request only ($script, $image...), a page's
			// look ($elemhide), what's done to a request ($redirect, $csp,
			// $removeparam), $badfilter, $popup: not by host alone.
			return rule, "", 0, false
		}
	}
	rule.domainSet = goAdSet(rule.domains)
	rule.notDomainSet = goAdSet(rule.notDomains)
	return rule, host, kind, true
}

// goAdSet is domains as a set, if there are enough of them to be worth it.
func goAdSet(domains []string) map[string]struct{} {
	if len(domains) < goAdDomainSetFrom {
		return nil
	}
	set := make(map[string]struct{}, len(domains))
	for _, d := range domains {
		set[d] = struct{}{}
	}
	return set
}

// goAdIn is whether host is one of domains (or set, the same as a set) or
// a subdomain of one.
func goAdIn(host string, domains []string, set map[string]struct{}) bool {
	if set != nil {
		for s := host; ; {
			if _, ok := set[s]; ok {
				return true
			}
			i := strings.IndexByte(s, '.')
			if i < 0 {
				return false
			}
			s = s[i+1:]
		}
	}
	for _, d := range domains {
		if host == d || len(host) > len(d) && host[len(host)-len(d)-1] == '.' && strings.HasSuffix(host, d) {
			return true
		}
	}
	return false
}

// goAdMatch is one request being decided: the host asked for, the page
// asking, and whether they're different sites, worked out only if a rule
// asks (it's a lookup in the public suffix list).
type goAdMatch struct {
	host, page string
	third      int8 // 0 not worked out yet; 1 different sites; -1 the same
}

func (m *goAdMatch) isThird() bool {
	if m.third == 0 {
		m.third = -1
		if goSite(m.host) != goSite(m.page) {
			m.third = 1
		}
	}
	return m.third == 1
}

// applies is whether the rule holds for the request.
func (m *goAdMatch) applies(rule *goAdRule) bool {
	if rule.party != 0 && rule.party == 1 != m.isThird() {
		return false
	}
	if rule.domains != nil && !goAdIn(m.page, rule.domains, rule.domainSet) {
		return false
	}
	return rule.notDomains == nil || !goAdIn(m.page, rule.notDomains, rule.notDomainSet)
}

func (m *goAdMatch) any(rules []goAdRule) bool {
	for i := range rules {
		if m.applies(&rules[i]) {
			return true
		}
	}
	return false
}

// goAdHost is a host as rules name it: lower case, without brackets or a
// trailing dot (copied only if it must change).
func goAdHost(h string) string {
	h = strings.TrimSuffix(h, ".")
	if len(h) > 1 && h[0] == '[' {
		h = strings.Trim(h, "[]")
	}
	for i := 0; i < len(h); i++ {
		if c := h[i]; c >= 'A' && c <= 'Z' {
			return strings.ToLower(h)
		}
	}
	return h
}

// goAdNumeric is whether host is an address (its last label a number, as
// no top-level domain is): only rules for it exactly apply, not those for
// "the domains above it".
func goAdNumeric(host string) bool {
	if host == "" {
		return false
	}
	c := host[len(host)-1]
	return c >= '0' && c <= '9' || strings.Contains(host, ":")
}

// blocked is whether r refuses a request to host for a page at page.
func (r *goAdRules) blocked(host, page string) bool {
	if r == nil {
		return false
	}
	host, page = goAdHost(host), goAdHost(page)
	if host == "" || page == "" || host == page {
		return false
	}
	key := goAdKey{host, page}
	if v, ok := r.cache.get(key); ok {
		return v
	}
	v := r.decide(host, page)
	r.cache.put(key, v)
	return v
}

// decide is blocked's answer, worked out.
func (r *goAdRules) decide(host, page string) bool {
	m := goAdMatch{host: host, page: page}
	if len(r.pageAllow) > 0 && r.pageAllowed(&m) {
		return false
	}
	blocked, important, allowed := false, false, false
	numeric := goAdNumeric(host)
	for s := host; ; {
		if e, ok := r.hosts[s]; ok {
			blocked = blocked || e.blockAll
			if more := e.more; more != nil {
				for i := range more.block {
					if !important && m.applies(&more.block[i]) {
						blocked = true
						important = more.block[i].important
					}
				}
				allowed = allowed || more.allow != nil && m.any(more.allow)
			}
		}
		i := strings.IndexByte(s, '.')
		if i < 0 || numeric {
			break
		}
		s = s[i+1:]
	}
	return blocked && (important || !allowed)
}

// goAdCache keeps what was decided, by host and page, for a set of rules
// (a new set starts with none). At most goAdCacheMax; then it starts
// again, which costs only the lookups it saved.
type goAdCache struct {
	mu sync.RWMutex
	m  map[goAdKey]bool
}

type goAdKey struct{ host, page string }

const goAdCacheMax = 16384

func (c *goAdCache) get(k goAdKey) (v, ok bool) {
	c.mu.RLock()
	v, ok = c.m[k]
	c.mu.RUnlock()
	return v, ok
}

func (c *goAdCache) put(k goAdKey, v bool) {
	c.mu.Lock()
	if c.m == nil || len(c.m) >= goAdCacheMax {
		c.m = make(map[goAdKey]bool, 256)
	}
	c.m[k] = v
	c.mu.Unlock()
}

// goParseAdList reads a list's rules into r, and what it says of how long
// it lasts ("! Expires: 4 days"; 0 if it doesn't).
func goParseAdList(r *goAdRules, data []byte) (rules int, expires time.Duration) {
	if len(r.hosts) == 0 {
		r.hosts = make(map[string]goAdEntry, bytes.Count(data, []byte("\n"))/2)
	}
	s := bufio.NewScanner(bytes.NewReader(data))
	s.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for s.Scan() {
		line := s.Bytes()
		if len(line) > 0 && line[0] == '!' {
			if bytes.Contains(line, []byte("Expires:")) {
				if v, ok := strings.CutPrefix(strings.TrimSpace(string(line[1:])), "Expires:"); ok {
					expires = goAdExpiry(v)
				}
			}
			continue
		}
		if r.add(string(line)) {
			rules++
		}
	}
	return rules, expires
}

// goAdExpiry reads "4 days" or "12 hours" (and "(update frequency)" after).
func goAdExpiry(v string) time.Duration {
	fields := strings.Fields(v)
	if len(fields) < 2 {
		return 0
	}
	n, err := strconv.Atoi(fields[0])
	if err != nil || n <= 0 || n > 365 {
		return 0
	}
	switch strings.TrimSuffix(strings.ToLower(fields[1]), "s") {
	case "day":
		return time.Duration(n) * 24 * time.Hour
	case "hour":
		return time.Duration(n) * time.Hour
	}
	return 0
}

// --- Lists, kept ---------------------------------------------------------------

// goAdList is a filter list: one of goAdBuiltIn, or one added by address.
type goAdList struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	URL          string    `json:"url"`
	On           bool      `json:"on"`
	Updated      time.Time `json:"updated,omitzero"`  // last had (or found unchanged)
	Tried        time.Time `json:"tried,omitzero"`    // last asked for
	Expires      int64     `json:"expires,omitempty"` // seconds it says it lasts
	ETag         string    `json:"etag,omitempty"`
	LastModified string    `json:"lastModified,omitempty"`
	Rules        int       `json:"rules"`       // rules used
	Unsupported  int       `json:"unsupported"` // rules that can't be, yet
	Error        string    `json:"error,omitempty"`

	builtIn  bool
	updating bool
	text     []byte // what was had, when there's no folder to keep it in
}

type goAdBlockFile struct {
	Enabled  bool        `json:"enabled"`
	Interval string      `json:"interval,omitempty"`
	Lists    []*goAdList `json:"lists"`
	Filters  string      `json:"filters,omitempty"` // My filters: the person's own rules
}

// My filters' limits: what can be kept, and how many of its lines that
// can't be used are said.
const (
	maxGoAdFilters        = 256 << 10
	maxGoAdFilterProblems = 50
)

type goAdBlock struct {
	mu       sync.Mutex
	file     string // "" kept in memory
	dir      string // the lists, beside the file
	client   *http.Client
	enabled  bool
	interval string
	lists    []*goAdList
	filters  string // My filters
	rules    atomic.Pointer[goAdRules]
	on       atomic.Bool // enabled, for each request to read without the lock
	updates  sync.Mutex  // one update at a time
	stop     chan struct{}
	// siteBlocks says whether a site's set to have ads blocked whatever
	// the default (gosites.go): the lists are wanted then, on or off.
	siteBlocks func() bool
}

// newGoAdBlock reads what's kept in file ("" for none), fetching lists
// where allow says, as the remote browser's own fetches do.
func newGoAdBlock(file string, allow func(netip.Addr) bool) *goAdBlock {
	client := newGoFetchClient(allow) // (DNS over HTTPS too, while it's on)
	transport := client.Transport.(*http.Transport).Clone()
	transport.DisableCompression = false // gzip, decoded (and limited decoded)
	client.Transport = goDNSTransport(transport)
	client.Timeout = goAdListTimeout
	a := &goAdBlock{file: file, client: client, interval: "daily", stop: make(chan struct{})}
	if file != "" {
		a.dir = filepath.Join(filepath.Dir(file), "go-filters")
	}
	for _, l := range goAdBuiltIn {
		l.builtIn = true
		a.lists = append(a.lists, &l)
	}
	a.load()
	a.rebuild()
	return a
}

func (a *goAdBlock) load() {
	if a.file == "" {
		return
	}
	data, err := os.ReadFile(a.file)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	var f goAdBlockFile
	if err == nil {
		err = json.Unmarshal(data, &f)
	}
	if err != nil {
		if aside, aerr := setAside(a.file); aerr == nil {
			log.Printf("go: ad blocking: %s couldn't be read (%v); set aside as %s", a.file, err, aside)
		} else {
			log.Printf("go: ad blocking: %s couldn't be read (%v) nor set aside (%v); kept in memory only", a.file, err, aerr)
			a.file, a.dir = "", ""
		}
		return
	}
	a.enabled = f.Enabled
	if len(f.Filters) <= maxGoAdFilters {
		a.filters = f.Filters
	}
	if _, ok := goAdIntervals[f.Interval]; ok {
		a.interval = f.Interval
	}
	for _, kept := range f.Lists {
		if kept == nil || kept.ID == "" {
			continue
		}
		if l := a.list(kept.ID); l != nil {
			// A built-in list: its name and address are this release's.
			name, address := l.Name, l.URL
			*l = *kept
			l.Name, l.URL, l.builtIn = name, address, true
			continue
		}
		if len(a.lists) >= maxGoAdLists || goAdListID(kept.URL) != kept.ID {
			continue
		}
		l := *kept
		a.lists = append(a.lists, &l)
	}
}

func (a *goAdBlock) save() {
	if a.file == "" {
		return
	}
	data, _ := json.MarshalIndent(goAdBlockFile{Enabled: a.enabled, Interval: a.interval, Lists: a.lists, Filters: a.filters}, "", " ")
	if err := writeFileAtomic(a.file, data); err != nil {
		log.Printf("go: ad blocking: saving: %v", err)
	}
}

// list is the list with id, nil if there's none (a.mu held).
func (a *goAdBlock) list(id string) *goAdList {
	for _, l := range a.lists {
		if l.ID == id {
			return l
		}
	}
	return nil
}

// goAdListID is an added list's ID, from its address.
func goAdListID(address string) string {
	sum := sha256.Sum256([]byte(address))
	return "url-" + hex.EncodeToString(sum[:6])
}

func (a *goAdBlock) path(l *goAdList) string { return filepath.Join(a.dir, l.ID+".txt") }

// had is whether there's a copy of l (a.mu held).
func (a *goAdBlock) had(l *goAdList) bool {
	if a.dir == "" {
		return l.text != nil
	}
	_, err := os.Stat(a.path(l))
	return err == nil
}

// text is what was had of l, nil if nothing (a.mu held).
func (a *goAdBlock) text(l *goAdList) []byte {
	if a.dir == "" {
		return l.text
	}
	data, err := os.ReadFile(a.path(l))
	if err != nil {
		return nil
	}
	return data
}

// rebuild reads the ticked lists into the rules in force; none if it's off.
// rebuild reads the ticked lists, and My filters, into the rules in force.
// They're read even while it's off: a site may be set to have its ads
// blocked anyway.
func (a *goAdBlock) rebuild() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.on.Store(a.enabled)
	r := newGoAdRules()
	for _, l := range a.lists {
		if l.On {
			goParseAdList(r, a.text(l))
		}
	}
	goParseAdList(r, []byte(a.filters))
	a.rules.Store(r)
}

// blocked is whether the rules in force refuse host for a page at page,
// as its site's set to (policy: "allow", "block", or "" for the default,
// on or off).
func (a *goAdBlock) blocked(host, page, policy string) bool {
	if policy == "allow" || policy == "" && !a.on.Load() {
		return false
	}
	r := a.rules.Load()
	return r.blocked(host, page) && !r.urlExcepted(host)
}

// blockedURL is whether the rules in force refuse a request of kind t to
// the address raw for a page at page, as its site's set to (policy); and
// whether it's its host that's refused, rather than the address.
func (a *goAdBlock) blockedURL(raw string, t uint16, page, policy string) (blocked, byHost bool) {
	if policy == "allow" || policy == "" && !a.on.Load() {
		return false, false
	}
	return a.rules.Load().blockedURL(raw, t, page)
}

// goAdBlockedURL is goAdBlock.blockedURL for the page's site's setting.
// Nothing, till the settings are read.
var goAdBlockedURL = func(raw string, t uint16, page string) (blocked, byHost bool) { return false, false }

// goAdFilterProblems are My filters' lines that can't be used, by their
// line number.
func goAdFilterProblems(text string) []map[string]any {
	out := []map[string]any{}
	r := newGoAdRules()
	for i, line := range strings.Split(text, "\n") {
		before := r.unsupported
		r.add(line)
		if r.unsupported > before {
			line = strings.TrimSpace(line)
			if len(line) > 200 {
				line = line[:200] + "…"
			}
			out = append(out, map[string]any{"line": i + 1, "text": strings.ToValidUTF8(line, "")})
			if len(out) >= maxGoAdFilterProblems {
				break
			}
		}
	}
	return out
}

// --- Fetching lists ------------------------------------------------------------

// fetch has l's list from its address: its text, or nil if it's unchanged
// since it was last had (as its server says). Lists come from where the
// remote browser may go, by HTTP or HTTPS.
func (a *goAdBlock) fetch(ctx context.Context, l goAdList, have bool) ([]byte, http.Header, error) {
	u, err := url.Parse(l.URL)
	if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" || u.User != nil {
		return nil, nil, errors.New("A filter list's address must be http or https, without a user name or password.")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, nil, errors.New("That isn't a filter list's address.")
	}
	req.Header.Set("User-Agent", "TabTop")
	req.Header.Set("Accept", "text/plain, */*;q=0.5")
	if have {
		if l.ETag != "" {
			req.Header.Set("If-None-Match", l.ETag)
		}
		if l.LastModified != "" {
			req.Header.Set("If-Modified-Since", l.LastModified)
		}
	}
	res, err := a.client.Do(req)
	if err != nil {
		if errors.Is(err, errFetchAddress) {
			return nil, nil, errors.New("Filter lists can't come from this machine or its private network.")
		}
		return nil, nil, fmt.Errorf("The list couldn't be downloaded: %v", fetchError(err))
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotModified && have {
		return nil, res.Header, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("The list's server answered HTTP %d.", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxGoAdListBytes+1))
	if err != nil {
		return nil, nil, fmt.Errorf("The list couldn't be downloaded: %v", err)
	}
	if len(data) > maxGoAdListBytes {
		return nil, nil, fmt.Errorf("The list is too large (over %d MB).", maxGoAdListBytes>>20)
	}
	return data, res.Header, nil
}

// update has list id anew; it says why not, if it couldn't.
func (a *goAdBlock) update(ctx context.Context, id string) error {
	a.mu.Lock()
	l := a.list(id)
	if l == nil {
		a.mu.Unlock()
		return errors.New("There's no such filter list.")
	}
	l.updating = true
	got, have := *l, a.had(l)
	a.mu.Unlock()
	data, header, err := a.fetch(ctx, got, have)
	var rules, unsupported int
	var expires time.Duration
	if err == nil && data != nil {
		r := newGoAdRules()
		_, expires = goParseAdList(r, data)
		rules, unsupported = r.supported, r.unsupported
		if err = goAdNotList(r, data); err == nil && a.dir != "" {
			if werr := writeFileAtomic(a.path(l), data); werr != nil {
				err = fmt.Errorf("The list couldn't be kept: %v", werr)
			}
		}
	}
	a.mu.Lock()
	l.updating = false
	l.Tried = time.Now()
	if err != nil {
		l.Error = err.Error()
	} else {
		l.Error = ""
		l.Updated = l.Tried
		if data != nil {
			l.Rules, l.Unsupported, l.Expires = rules, unsupported, int64(expires/time.Second)
			l.ETag, l.LastModified = header.Get("ETag"), header.Get("Last-Modified")
			if a.dir == "" {
				l.text = data
			}
		}
	}
	a.save()
	a.mu.Unlock()
	if err == nil && data != nil {
		a.rebuild()
	}
	return err
}

// Which lists updateAll has: every ticked one (Update now); those not had
// yet (just turned on, or ticked); or those due (as time goes by).
const (
	goAdAll = iota
	goAdMissing
	goAdDue
)

// updateAll has the lists which says, one at a time; the first reason one
// couldn't be had, if any.
func (a *goAdBlock) updateAll(ctx context.Context, which int) error {
	a.updates.Lock()
	defer a.updates.Unlock()
	var first error
	for _, id := range a.due(which) {
		if err := a.update(ctx, id); err != nil {
			log.Printf("go: ad blocking: list %s: %v", id, err)
			if first == nil {
				first = err
			}
		}
	}
	return first
}

// due is the ticked lists which says to have now. As time goes by: those
// not had (tried again every goAdRetry), and those older than the
// interval, or than they say they last (but kept goAdMinExpiry at least);
// a list that failed, not till goAdRetry after. None while it's off.
func (a *goAdBlock) due(which int) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.enabled && (a.siteBlocks == nil || !a.siteBlocks()) {
		return nil
	}
	now := time.Now()
	every := goAdIntervals[a.interval]
	var ids []string
	for _, l := range a.lists {
		if !l.On {
			continue
		}
		had, retry := a.had(l), l.Tried.IsZero() || now.Sub(l.Tried) >= goAdRetry
		due := false
		switch {
		case which == goAdAll:
			due = true
		case !had:
			due = which == goAdMissing || retry
		case which == goAdMissing, every == 0, l.Error != "" && !retry:
		default:
			wait := every
			if e := time.Duration(l.Expires) * time.Second; e > 0 {
				wait = min(wait, max(e, goAdMinExpiry))
			}
			due = now.Sub(l.Updated) >= wait
		}
		if due {
			ids = append(ids, l.ID)
		}
	}
	return ids
}

// run updates the lists due, now and every goAdCheck, till close.
func (a *goAdBlock) run() {
	t := time.NewTicker(goAdCheck)
	defer t.Stop()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), goAdListTimeout*maxGoAdLists)
		a.updateAll(ctx, goAdDue)
		cancel()
		select {
		case <-t.C:
		case <-a.stop:
			return
		}
	}
}

func (a *goAdBlock) close() { close(a.stop) }

// --- Rules by address ------------------------------------------------------
//
// Rules for part of a site (||ads.example/banner/, /ads/*.js, ?adunit=),
// or for some kinds of request ($script, $image, $xmlhttprequest), are held
// to where the whole address and the kind are known: requests the engine's
// page makes (Fetch interception, paused as they're asked for), and what the
// server fetches for the page's copy. Not by the proxy, which sees HTTPS by
// host only.
//
// They're kept by a word in their pattern ("banner" in /banner/*), one a
// rule, chosen so that an address the rule matches has that word whole: a
// request's address is split into its words, and only the rules kept by
// them are tried, as lists' rules are in ad blockers that keep tens of
// thousands. A rule without such a word is tried for every request: few.

// The kinds of request a rule may be for, as lists name them.
const (
	goAdTScript uint16 = 1 << iota
	goAdTImage
	goAdTStylesheet
	goAdTXHR
	goAdTSubdocument
	goAdTMedia
	goAdTFont
	goAdTPing
	goAdTWebsocket
	goAdTObject
	goAdTOther
	goAdTAll = 1<<iota - 1
)

var goAdTypes = map[string]uint16{
	"script": goAdTScript, "image": goAdTImage, "stylesheet": goAdTStylesheet, "css": goAdTStylesheet,
	"xmlhttprequest": goAdTXHR, "xhr": goAdTXHR, "subdocument": goAdTSubdocument, "frame": goAdTSubdocument,
	"media": goAdTMedia, "font": goAdTFont, "ping": goAdTPing, "beacon": goAdTPing, "websocket": goAdTWebsocket,
	"object": goAdTObject, "object-subrequest": goAdTObject, "other": goAdTOther,
}

// goAdCDPTypes are the engine's kinds of request (Fetch's resourceType),
// as lists name them. A document is a subdocument here: the page's own is
// never one a rule is held to.
var goAdCDPTypes = map[string]uint16{
	"Script": goAdTScript, "Image": goAdTImage, "Stylesheet": goAdTStylesheet, "XHR": goAdTXHR, "Fetch": goAdTXHR,
	"Document": goAdTSubdocument, "Media": goAdTMedia, "Font": goAdTFont, "Ping": goAdTPing,
	"CSPViolationReport": goAdTPing, "WebSocket": goAdTWebsocket,
}

// goAdKindTypes are the server's fetches for a page's copy, by kind.
var goAdKindTypes = map[string]uint16{"image": goAdTImage, "css": goAdTStylesheet, "font": goAdTFont, "media": goAdTMedia}

// goAdURLRule is a rule for addresses matching a pattern.
type goAdURLRule struct {
	pattern    string // as lists write it, without its anchors: * any, ^ a separator
	lead       string // its text before any * or ^: where a match can start is where this is
	hostAnchor bool   // ||: from the start of the host, or of a label in it
	start, end bool   // |: from the start of the address; to its end
	matchCase  bool
	types      uint16 // the kinds it's for
	goAdRule          // whose pages, important
}

// goAdURLIndex is rules kept by a word in their patterns: of the words an
// address the rule matches must have, the one fewest rules have, so each
// is tried for as few requests as can be. Which that is is known once all
// the rules are read: they're kept as they come, and indexed when first
// asked of.
type goAdURLIndex struct {
	pending []*goAdURLRule
	once    sync.Once
	byWord  map[string][]*goAdURLRule
	rest    []*goAdURLRule // without such a word: tried for every request
}

func (x *goAdURLIndex) add(r *goAdURLRule) { x.pending = append(x.pending, r) }

// build indexes the rules read.
func (x *goAdURLIndex) build() {
	words := make([][]string, len(x.pending))
	count := map[string]int{}
	for i, r := range x.pending {
		words[i] = goAdPatternWords(r)
		for _, w := range words[i] {
			count[w]++
		}
	}
	x.byWord = make(map[string][]*goAdURLRule, len(count))
	for i, r := range x.pending {
		best := ""
		for _, w := range words[i] {
			if best == "" || count[w] < count[best] || count[w] == count[best] && len(w) > len(best) {
				best = w
			}
		}
		if best == "" {
			x.rest = append(x.rest, r)
		} else {
			x.byWord[best] = append(x.byWord[best], r)
		}
	}
	x.pending = nil
}

// goAdWordByte is whether c is part of a word, as addresses are split.
func goAdWordByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '%'
}

// goAdCommonWords are words in so many addresses that a rule kept by one
// would be tried for nearly every request.
var goAdCommonWords = map[string]bool{"http": true, "https": true, "www": true, "com": true, "net": true, "org": true}

// goAdPatternWords are the words a rule could be kept by: those in its
// pattern that an address it matches must have whole (bounded on both
// sides by what isn't a word, an anchor, or ^; never next to *).
func goAdPatternWords(r *goAdURLRule) []string {
	p := r.pattern
	if r.matchCase {
		p = strings.ToLower(p)
	}
	var out []string
	for i := 0; i < len(p); {
		if !goAdWordByte(p[i]) {
			i++
			continue
		}
		j := i
		for j < len(p) && goAdWordByte(p[j]) {
			j++
		}
		before := i > 0 && p[i-1] != '*' || i == 0 && (r.start || r.hostAnchor)
		after := j < len(p) && p[j] != '*' || j == len(p) && r.end
		if w := p[i:j]; before && after && len(w) >= 2 && !goAdCommonWords[w] && !slices.Contains(out, w) {
			out = append(out, w)
		}
		i = j
	}
	return out
}

// goAdSep is whether c is a separator, as ^ matches: not a letter, digit,
// or one of _ - . %.
func goAdSep(c byte) bool {
	return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.' || c == '%')
}

// goAdGlob is whether pattern matches s from its start (to its end, if
// end): * matches anything, ^ a separator or s's end.
func goAdGlob(p, s string, end bool) bool {
	pi, si, starP, starS := 0, 0, -1, 0
	for {
		if pi < len(p) {
			c := p[pi]
			switch {
			case c == '*':
				starP, starS = pi, si
				pi++
				continue
			case si < len(s) && (c == s[si] || c == '^' && goAdSep(s[si])):
				pi++
				si++
				continue
			case c == '^' && si == len(s):
				pi++
				continue
			}
		} else if !end || si == len(s) {
			return true
		}
		if starP < 0 || starS >= len(s) {
			return false
		}
		starS++
		si, pi = starS, starP+1
	}
}

// matches is whether r's pattern matches the address u (lower: the same,
// in lower case), whose host is u[hostStart:hostEnd].
func (r *goAdURLRule) matches(u, lower string, hostStart, hostEnd int) bool {
	s := lower
	if r.matchCase {
		s = u
	}
	if r.start {
		return strings.HasPrefix(s, r.lead) && goAdGlob(r.pattern, s, r.end)
	}
	// Where a match may start: where its leading text is (found fast);
	// every place, if it starts with ^.
	from, to := 0, len(s)
	if r.hostAnchor {
		from, to = hostStart, hostEnd
	}
	for i := from; i < to; i++ {
		if r.lead != "" {
			j := strings.Index(s[i:], r.lead)
			if j < 0 || i+j >= to {
				return false
			}
			i += j
		}
		if (!r.hostAnchor || i == hostStart || s[i-1] == '.') && goAdGlob(r.pattern, s[i:], r.end) {
			return true
		}
	}
	return false
}

// goParseAdURLRule reads a rule for addresses; ok false if it isn't one
// that can be held to (a regular expression, an option for what's done to
// a request rather than whether it's made).
func goParseAdURLRule(line string) (rule *goAdURLRule, exception, ok bool) {
	if strings.HasPrefix(line, "@@") {
		exception = true
		line = line[2:]
	}
	pattern, options := line, ""
	if i := strings.LastIndexByte(line, '$'); i >= 0 && !strings.Contains(line[i:], "/") {
		pattern, options = line[:i], line[i+1:]
	}
	if strings.HasPrefix(pattern, "/") && strings.HasSuffix(pattern, "/") && len(pattern) > 1 {
		return nil, false, false // a regular expression
	}
	r := &goAdURLRule{types: goAdTAll}
	switch {
	case strings.HasPrefix(pattern, "||"):
		r.hostAnchor, pattern = true, pattern[2:]
	case strings.HasPrefix(pattern, "|"):
		r.start, pattern = true, pattern[1:]
	}
	if strings.HasSuffix(pattern, "|") {
		r.end, pattern = true, pattern[:len(pattern)-1]
	}
	pattern = strings.Trim(pattern, "*")
	if pattern == "" || len(pattern) > 2048 || strings.ContainsAny(pattern, " \t") {
		return nil, false, false // everything, or not a pattern
	}
	var types, notTypes uint16
	for _, o := range strings.Split(options, ",") {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		name, value, _ := strings.Cut(o, "=")
		not := strings.HasPrefix(name, "~")
		bare := strings.TrimPrefix(strings.ToLower(name), "~")
		switch {
		case goAdTypes[bare] != 0 && not:
			notTypes |= goAdTypes[bare]
		case goAdTypes[bare] != 0:
			types |= goAdTypes[bare]
		case bare == "third-party" || bare == "3p" || bare == "strict3p":
			r.party = 1
			if not {
				r.party = -1
			}
		case bare == "first-party" || bare == "1p" || bare == "strict1p":
			r.party = -1
			if not {
				r.party = 1
			}
		case bare == "match-case":
			r.matchCase = !not
		case bare == "important":
			r.important = true
		case bare == "all":
			types = goAdTAll
		case bare == "domain" || bare == "from":
			for _, d := range strings.Split(strings.ToLower(value), "|") {
				neg := strings.HasPrefix(d, "~")
				d = strings.TrimPrefix(d, "~")
				if !goAdHostName(d) {
					return nil, false, false
				}
				if neg {
					r.notDomains = append(r.notDomains, d)
				} else {
					r.domains = append(r.domains, d)
				}
			}
		default:
			// $document, $popup, $redirect, $csp, $removeparam, $badfilter,
			// $denyallow...: not whether a page's request is made.
			return nil, false, false
		}
	}
	if types != 0 {
		r.types = types
	}
	r.types &^= notTypes
	if r.types == 0 {
		return nil, false, false
	}
	if !r.matchCase {
		pattern = strings.ToLower(pattern)
	}
	r.pattern = pattern
	r.lead = pattern
	if i := strings.IndexAny(pattern, "*^"); i >= 0 {
		r.lead = pattern[:i]
	}
	r.domainSet, r.notDomainSet = goAdSet(r.domains), goAdSet(r.notDomains)
	return r, exception, true
}

// goAdURLParts are a request's address, as rules are held to it.
type goAdURLParts struct {
	url, lower         string
	hostStart, hostEnd int
	host               string
}

func goAdSplitURL(raw string) (goAdURLParts, bool) {
	p := goAdURLParts{url: raw, lower: strings.ToLower(raw)}
	i := strings.Index(raw, "://")
	if i < 0 {
		return p, false
	}
	p.hostStart = i + 3
	p.hostEnd = len(raw)
	if j := strings.IndexAny(raw[p.hostStart:], "/?#"); j >= 0 {
		p.hostEnd = p.hostStart + j
	}
	authority := p.lower[p.hostStart:p.hostEnd]
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		p.hostStart += at + 1
		authority = authority[at+1:]
	}
	host := authority
	if !strings.HasPrefix(host, "[") {
		if c := strings.LastIndexByte(host, ':'); c >= 0 {
			p.hostEnd -= len(host) - c
			host = host[:c]
		}
	}
	p.host = goAdHost(host)
	return p, p.host != ""
}

// anyIn is whether any of x's rules, for the address's words, matches a
// request of kind t to it from a page (m).
func (x *goAdURLIndex) anyIn(m *goAdMatch, u *goAdURLParts, t uint16, important bool) bool {
	x.once.Do(x.build)
	try := func(rules []*goAdURLRule) bool {
		for _, r := range rules {
			if r.types&t != 0 && (!important || r.important) && m.applies(&r.goAdRule) && r.matches(u.url, u.lower, u.hostStart, u.hostEnd) {
				return true
			}
		}
		return false
	}
	if try(x.rest) {
		return true
	}
	if x.byWord == nil {
		return false
	}
	s := u.lower
	var seen [32]string
	n := 0
outer:
	for i := 0; i < len(s); {
		if !goAdWordByte(s[i]) {
			i++
			continue
		}
		j := i
		for j < len(s) && goAdWordByte(s[j]) {
			j++
		}
		w := s[i:j]
		i = j
		for _, v := range seen[:n] {
			if v == w {
				continue outer
			}
		}
		if n < len(seen) {
			seen[n] = w
			n++
		}
		if rules := x.byWord[w]; rules != nil && try(rules) {
			return true
		}
	}
	return false
}

// blockedURL is whether r refuses a request of kind t to the address raw,
// for a page at page; and whether its host's what's refused (a host rule),
// rather than the address.
func (r *goAdRules) blockedURL(raw string, t uint16, page string) (blocked, byHost bool) {
	if r == nil || t == 0 {
		return false, false
	}
	u, ok := goAdSplitURL(raw)
	page = goAdHost(page)
	if !ok || page == "" {
		return false, false
	}
	m := goAdMatch{host: u.host, page: page}
	if len(r.pageAllow) > 0 && r.pageAllowed(&m) {
		return false, false
	}
	byHost = r.blocked(u.host, page)
	blocked = byHost || r.urlBlock.anyIn(&m, &u, t, false)
	if !blocked {
		return false, false
	}
	if r.urlBlock.anyIn(&m, &u, t, true) {
		return true, byHost // important: no exception undoes it
	}
	if r.urlAllow.anyIn(&m, &u, t, false) {
		return false, false
	}
	return true, byHost
}

// --- Hiding what pages show --------------------------------------------------
//
// Element hiding rules (##.ad, example.com##.sponsor, #@# exceptions) are
// hidden in the page's copy by a stylesheet (go-frame.js), selector by
// selector. Lists have tens of thousands of them, nearly all for a class or
// an id, so they're kept by the first class or id they need (filed under
// ".ad" or "#banner"; a selector can't match where that's nowhere in the
// page), and a page is sent only those for the classes and ids it has, as
// its snapshot and its changes bring them (goAdHider), with the few that
// need neither, and its site's own.

// goAdHide is a set of lists' element hiding rules.
type goAdHide struct {
	generic       map[string][]goAdHideRule // by the class (".ad") or id ("#ad") they need
	unkeyed       []goAdHideRule            // those that need neither: for every page
	specific      map[string][]goAdHideRule // by the site they're for
	except        map[string][]string       // by site: selectors not hidden there
	genericExcept map[string]bool           // selectors not hidden anywhere
	pages         map[string]uint8          // by site: goAdNoGeneric, goAdNoHide
	count         int
}

// A page's exceptions: generic rules not hidden ($generichide), or none
// ($elemhide).
const (
	goAdNoGeneric = 1 << iota
	goAdNoHide
)

type goAdHideRule struct {
	sel string
	not []string // the sites it isn't for
}

// goAdProcedural are extended selectors, for scripts to work out, not CSS.
var goAdProcedural = []string{":has-text(", ":-abp-", ":xpath(", ":upward(", ":matches-css", ":style(", ":remove(",
	":min-text-length(", ":watch-attr(", ":matches-path(", ":others(", ":if(", ":if-not(", ":nth-ancestor(",
	":matches-attr(", ":matches-prop(", ":remove-attr(", ":remove-class(", ":contains(", ":-ext-"}

// goAdSelector is whether sel can go in a stylesheet as a selector, and
// nothing more: no block, no declarations, at-rules, escapes, comments,
// urls, or a script's own syntax.
func goAdSelector(sel string) bool {
	if sel == "" || len(sel) > 1000 || strings.ContainsAny(sel, "{};@\\<\n\r") || strings.Contains(sel, "/*") ||
		strings.Contains(strings.ToLower(sel), "url(") {
		return false
	}
	for _, p := range goAdProcedural {
		if strings.Contains(sel, p) {
			return false
		}
	}
	return true
}

// goAdSelectorKey is the class or id sel needs: the first in its first
// compound (.ad in ins.ad > a), "" if there's none there.
func goAdSelectorKey(sel string) string {
	depth := 0
	for i := 0; i < len(sel); i++ {
		switch c := sel[i]; c {
		case '[', '(':
			depth++
		case ']', ')':
			depth--
		case ' ', '>', '+', '~', ',':
			if depth == 0 {
				return ""
			}
		case '"', '\'':
			if j := strings.IndexByte(sel[i+1:], c); j >= 0 {
				i += j + 1
			}
		case '.', '#':
			if depth != 0 {
				continue
			}
			j := i + 1
			for j < len(sel) && goAdIdentByte(sel[j]) {
				j++
			}
			if j > i+1 {
				return sel[i:j]
			}
		}
	}
	return ""
}

func goAdIdentByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c >= 0x80
}

// goAdSplitSelectors splits a selector list at its top-level commas.
func goAdSplitSelectors(list string) []string {
	var out []string
	depth, start := 0, 0
	for i := 0; i < len(list); i++ {
		switch c := list[i]; c {
		case '[', '(':
			depth++
		case ']', ')':
			depth--
		case '"', '\'':
			if j := strings.IndexByte(list[i+1:], c); j >= 0 {
				i += j + 1
			}
		case ',':
			if depth == 0 {
				out = append(out, strings.TrimSpace(list[start:i]))
				start = i + 1
			}
		}
	}
	return append(out, strings.TrimSpace(list[start:]))
}

// addHide reads an element hiding rule, if line is one: whether it was,
// and whether it can be used.
func (r *goAdRules) addHide(line string) (hiding, ok bool) {
	at := strings.Index(line, "#")
	if at < 0 {
		return false, false
	}
	rest := line[at:]
	exception := strings.HasPrefix(rest, "#@#")
	switch {
	case exception:
		rest = rest[3:]
	case strings.HasPrefix(rest, "##"):
		rest = rest[2:]
	case strings.HasPrefix(rest, "#?#"), strings.HasPrefix(rest, "#$#"), strings.HasPrefix(rest, "#%#"), strings.HasPrefix(rest, "#@?#"),
		strings.HasPrefix(rest, "#@$#"), strings.HasPrefix(rest, "#@%#"):
		return true, false // what a script does, not a stylesheet
	default:
		return false, false
	}
	if strings.HasPrefix(rest, "+js(") || strings.HasPrefix(rest, "^") {
		return true, false // a scriptlet, or HTML filtering
	}
	var domains, not []string
	if at > 0 {
		for _, d := range strings.Split(strings.ToLower(line[:at]), ",") {
			d = strings.TrimSpace(d)
			neg := strings.HasPrefix(d, "~")
			d = strings.TrimPrefix(d, "~")
			if !goAdHostName(d) {
				return true, false // an entity (example.*), a pattern
			}
			if neg {
				not = append(not, d)
			} else {
				domains = append(domains, d)
			}
		}
	}
	sels := goAdSplitSelectors(rest)
	for _, sel := range sels {
		if !goAdSelector(sel) {
			return true, false
		}
	}
	h := &r.hide
	if h.generic == nil {
		h.generic, h.specific, h.except, h.genericExcept, h.pages =
			map[string][]goAdHideRule{}, map[string][]goAdHideRule{}, map[string][]string{}, map[string]bool{}, map[string]uint8{}
	}
	for _, sel := range sels {
		switch {
		case exception && len(domains) == 0:
			h.genericExcept[sel] = true
		case exception:
			for _, d := range domains {
				h.except[d] = append(h.except[d], sel)
			}
		case len(domains) > 0:
			for _, d := range domains {
				h.specific[d] = append(h.specific[d], goAdHideRule{sel, not})
			}
		default:
			if key := goAdSelectorKey(sel); key != "" {
				h.generic[key] = append(h.generic[key], goAdHideRule{sel, not})
			} else {
				h.unkeyed = append(h.unkeyed, goAdHideRule{sel, not})
			}
		}
		if !exception {
			h.count++
		}
	}
	return true, true
}

// goAdHider is what's hidden on one page: those of the rules for its site,
// and for the classes and ids it's shown so far; each selector once.
type goAdHider struct {
	r       *goAdRules
	page    string
	generic bool            // generic rules hidden (no $generichide)
	except  map[string]bool // its site's exceptions
	keys    map[string]bool // classes and ids seen
	sent    map[string]bool // selectors given
}

// maxGoAdHideKeys is how many classes and ids a page's hider keeps; past
// that, new ones go unlooked (a page that names its elements randomly).
const maxGoAdHideKeys = 20000

// hider is a page's, nil if nothing's hidden there.
func (r *goAdRules) hider(page string) *goAdHider {
	if r == nil || r.hide.count == 0 {
		return nil
	}
	page = goAdHost(page)
	h := &goAdHider{r: r, page: page, generic: true, except: map[string]bool{}, keys: map[string]bool{}, sent: map[string]bool{}}
	for s := page; s != ""; {
		if f := r.hide.pages[s]; f&goAdNoHide != 0 {
			return nil
		} else if f&goAdNoGeneric != 0 {
			h.generic = false
		}
		for _, sel := range r.hide.except[s] {
			h.except[sel] = true
		}
		i := strings.IndexByte(s, '.')
		if i < 0 || goAdNumeric(page) {
			break
		}
		s = s[i+1:]
	}
	return h
}

// goAdHideRemoteOK is whether sel may hide something in the remoted copy.
// Selectors that match blob: URLs would hide every picture (and styled
// background) the frame loads: those come only as blob: URLs (the frame's
// CSP allows no other origin). Filter lists use them against sites that put
// ads in blob: URLs (e.g. img[src*="blob:"]); here they'd hide the
// page's own pictures once the broker has fetched them.
func goAdHideRemoteOK(sel string) bool {
	sel = strings.ToLower(goCSSUnescape(sel))
	if strings.Contains(sel, "blob:") {
		return false
	}
	// Nor one matching them by a part of it ([src^="blob"], [src*="lob:"]).
	for _, m := range goAdBlobAttr.FindAllStringSubmatch(sel, -1) {
		if v := m[1]; strings.Contains(v, "blob") || len(v) >= 3 && strings.Contains("blob:", v) {
			return false
		}
	}
	return true
}

// goAdBlobAttr is an attribute selector on what holds a picture's address
// in the copy (always a blob: URL), and the value it matches.
var goAdBlobAttr = regexp.MustCompile(`\[\s*(?:src|srcset|style|poster|href|data)\s*[\^*$|~]?=\s*["']?([^"'\]]*)`)

// goCSSUnescape takes CSS escapes out of s (\3a or \: for ':'), so a
// selector can't hide what it matches from goAdHideRemoteOK by escaping it.
func goCSSUnescape(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 == len(s) {
			b.WriteByte(s[i])
			continue
		}
		j := i + 1
		for j < len(s) && j < i+7 && strings.IndexByte("0123456789abcdefABCDEF", s[j]) >= 0 {
			j++
		}
		if j == i+1 {
			b.WriteByte(s[j]) // \: and the like: the character itself
			i = j
			continue
		}
		if n, err := strconv.ParseUint(s[i+1:j], 16, 32); err == nil && n > 0 && n <= 0x10ffff {
			b.WriteRune(rune(n))
		}
		if j < len(s) && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n') {
			j++ // (the space ending a hex escape)
		}
		i = j - 1
	}
	return b.String()
}

// take adds what rules (generic ones, or the site's) hold for the page,
// and haven't been given.
func (h *goAdHider) take(out []string, rules []goAdHideRule, generic bool) []string {
	for _, rule := range rules {
		if h.sent[rule.sel] || h.except[rule.sel] || generic && h.r.hide.genericExcept[rule.sel] ||
			rule.not != nil && goAdIn(h.page, rule.not, nil) || !goAdHideRemoteOK(rule.sel) {
			continue
		}
		h.sent[rule.sel] = true
		out = append(out, rule.sel)
	}
	return out
}

// start is the selectors for the page whatever it shows: its site's own,
// and the generic ones that need no class or id.
func (h *goAdHider) start() []string {
	out := []string{}
	for s := h.page; s != ""; {
		out = h.take(out, h.r.hide.specific[s], false)
		i := strings.IndexByte(s, '.')
		if i < 0 || goAdNumeric(h.page) {
			break
		}
		s = s[i+1:]
	}
	if h.generic {
		out = h.take(out, h.r.hide.unkeyed, true)
	}
	return out
}

// see is the selectors a class (".ad") or id ("#ad") the page shows brings,
// the first time it's seen.
func (h *goAdHider) see(out []string, key string) []string {
	if !h.generic || h.keys[key] || len(h.keys) >= maxGoAdHideKeys {
		return out
	}
	h.keys[key] = true
	if rules := h.r.hide.generic[key]; rules != nil {
		out = h.take(out, rules, true)
	}
	return out
}

// seeNode is the selectors the classes and ids in n bring.
func (h *goAdHider) seeNode(out []string, n *goNode) []string {
	if n == nil {
		return out
	}
	for i := 0; i+1 < len(n.Attrs); i += 2 {
		out = h.seeAttr(out, n.Attrs[i], n.Attrs[i+1])
	}
	for _, k := range n.Kids {
		if k != nil && k.Base == "" { // an embedded page's: not this one's
			out = h.seeNode(out, k)
		}
	}
	return out
}

// seeAttr is the selectors an element's class or id brings.
func (h *goAdHider) seeAttr(out []string, name, value string) []string {
	switch name {
	case "id":
		if value != "" {
			out = h.see(out, "#"+value)
		}
	case "class":
		for _, c := range strings.Fields(value) {
			out = h.see(out, "."+c)
		}
	}
	return out
}

// goAdHideRules are the rules a page at page has hidden: nil if none (ad
// blocking off there, or its site's allowed). Nothing, till the settings
// are read.
var goAdHideRules = func(page string) *goAdRules { return nil }

// hideRules is goAdHideRules' answer, for a page whose site's set to
// policy.
func (a *goAdBlock) hideRules(policy string) *goAdRules {
	if policy == "allow" || policy == "" && !a.on.Load() {
		return nil
	}
	return a.rules.Load()
}

// startHiding is what's hidden on a snapshot's page (at url, its tree doc),
// from scratch; nil for nothing.
func (b *goBrowser) startHiding(url string, doc *goNode) []string {
	b.hideMu.Lock()
	defer b.hideMu.Unlock()
	page := goPageHost(url)
	b.hider = goAdHideRules(page).hider(page)
	if b.hider == nil {
		return nil
	}
	return b.hider.seeNode(b.hider.start(), doc)
}

// moreHiding is what a batch of changes (its nodes, its attributes) brings
// to hide; nil for nothing new.
func (b *goBrowser) moreHiding(nodes []*goNode, attrs [][2]string) []string {
	b.hideMu.Lock()
	defer b.hideMu.Unlock()
	if b.hider == nil {
		return nil
	}
	var out []string
	for _, n := range nodes {
		out = b.hider.seeNode(out, n)
	}
	for _, a := range attrs {
		out = b.hider.seeAttr(out, a[0], a[1])
	}
	return out
}

// --- What a tab's page asks for ------------------------------------------------

// adPaused is given each request the engine pauses (cdpConn.paused): it
// takes the page's subresources, decided by their addresses and kinds and
// answered at once, off the tab's event loop; documents it leaves to the
// loop (storagePaused).
func (b *goBrowser) adPaused(ev cdpEvent) bool {
	var p struct {
		ID      string `json:"requestId"`
		Type    string `json:"resourceType"`
		Request struct {
			URL string `json:"url"`
		} `json:"request"`
	}
	if ev.SessionID != b.page || json.Unmarshal(ev.Params, &p) != nil || p.ID == "" || p.Type == "Document" {
		return false
	}
	t := goAdCDPTypes[p.Type]
	if t == 0 {
		t = goAdTOther
	}
	go func() {
		if b.adRefused(p.ID, p.Request.URL, t) {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		b.resumePaused(ctx, b.cdp.call(ctx, b.page, "Fetch.continueRequest", map[string]string{"requestId": p.ID}, nil))
	}()
	return true
}

// adRefused fails a paused request, if it's an ad's or a tracker's for the
// page the tab's at: whether it did.
func (b *goBrowser) adRefused(id, raw string, t uint16) bool {
	page := ""
	if b.e != nil {
		if p := b.e.proxy.page.Load(); p != nil {
			page = *p
		}
	}
	blocked, byHost := goAdBlockedURL(raw, t, page)
	if !blocked {
		return false
	}
	what := raw
	if byHost {
		what = goPageHost(raw)
	}
	b.adCounted(what)
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	defer cancel()
	b.resumePaused(ctx, b.cdp.call(ctx, b.page, "Fetch.failRequest", map[string]string{"requestId": id, "errorReason": "BlockedByClient"}, nil))
	return true
}

// resumePaused looks at what letting a paused request go, or failing it,
// came to: a request gone meanwhile (the page left) is nothing; any other
// failure leaves the engine waiting, so interception is turned off for the
// tab (the proxy's blocking by host still holds).
func (b *goBrowser) resumePaused(ctx context.Context, err error) {
	if err == nil {
		return
	}
	if cdpRequestGone(err) {
		return
	}
	b.cdp.disableInterception(b.page, "could not resume a request: "+err.Error())
}

// --- What a tab's page had blocked ---------------------------------------------

// goAdCountEvery is how often, at most, a tab says how many hosts it's
// refused for its page: a page asks for many at once.
const goAdCountEvery = 300 * time.Millisecond

// maxGoAdCount is how many hosts are counted for a page.
const maxGoAdCount = 999

// goAdCount is what's refused as ads' and trackers' for the page a tab's at:
// by the engine (as it asks), its proxy, and the server's fetches for the
// page's copy. Each thing once: a host, refused whole (HTTPS through the
// proxy is named by host only, and the same picture's refused there and
// again when the copy asks for it), or an address.
type goAdCount struct {
	mu    sync.Mutex
	hosts map[string]struct{}
	timer *time.Timer
}

// adCounted counts a host or an address refused for the page, and says so
// soon.
func (b *goBrowser) adCounted(host string) {
	c := &b.adCount
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hosts == nil {
		c.hosts = map[string]struct{}{}
	}
	if _, ok := c.hosts[host]; ok || len(c.hosts) >= maxGoAdCount {
		return
	}
	c.hosts[host] = struct{}{}
	if c.timer == nil {
		c.timer = time.AfterFunc(goAdCountEvery, b.sendAdCount)
	}
}

func (b *goBrowser) sendAdCount() {
	c := &b.adCount
	c.mu.Lock()
	n := len(c.hosts)
	c.timer = nil
	c.mu.Unlock()
	b.send(map[string]any{"type": "go-ads", "count": n})
}

// newAdPage starts counting for a new page (the page says 0 itself, as it
// starts loading one).
func (b *goBrowser) newAdPage() {
	c := &b.adCount
	c.mu.Lock()
	c.hosts = nil
	c.mu.Unlock()
}

// --- Settings ------------------------------------------------------------------

func (a *goAdBlock) report() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	lists := []map[string]any{}
	for _, l := range a.lists {
		item := map[string]any{"id": l.ID, "name": l.Name, "url": l.URL, "on": l.On, "builtIn": l.builtIn,
			"rules": l.Rules, "unsupported": l.Unsupported, "updating": l.updating, "had": a.had(l)}
		if !l.Updated.IsZero() {
			item["updated"] = l.Updated.UnixMilli()
		}
		if l.Error != "" {
			item["error"] = l.Error
		}
		lists = append(lists, item)
	}
	report := map[string]any{"enabled": a.enabled, "interval": a.interval, "lists": lists, "kept": a.file != "",
		"filters": a.filters, "filterProblems": goAdFilterProblems(a.filters)}
	if r := a.rules.Load(); r != nil {
		report["rules"], report["unsupported"] = r.supported, r.unsupported
	}
	return report
}

// set makes a change: on, off; daily, weekly, manual; list-on, list-off,
// list-remove (id: the list); list-add (address: the list's); filters
// (text: My filters). What's asked for that isn't had yet is downloaded
// before it answers.
func (a *goAdBlock) set(ctx context.Context, setting, id, address, text string) error {
	a.mu.Lock()
	switch setting {
	case "filters":
		if len(text) > maxGoAdFilters {
			a.mu.Unlock()
			return fmt.Errorf("My filters can hold at most %d KB.", maxGoAdFilters>>10)
		}
		a.filters = strings.ReplaceAll(strings.ToValidUTF8(text, ""), "\r\n", "\n")
	case "on", "off":
		a.enabled = setting == "on"
	case "daily", "weekly", "manual":
		a.interval = setting
	case "list-on", "list-off", "list-remove":
		l := a.list(id)
		if l == nil {
			a.mu.Unlock()
			return errors.New("There's no such filter list.")
		}
		if setting == "list-remove" {
			if l.builtIn {
				a.mu.Unlock()
				return errors.New("A built-in list can be turned off, not removed.")
			}
			a.lists = slices.DeleteFunc(a.lists, func(x *goAdList) bool { return x == l })
			if a.dir != "" {
				os.Remove(a.path(l))
			}
		} else {
			l.On = setting == "list-on"
		}
	case "list-add":
		u, err := url.Parse(strings.TrimSpace(address))
		if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" || u.User != nil || len(address) > 2048 {
			a.mu.Unlock()
			return errors.New("Give the list's http or https address.")
		}
		u.Fragment = ""
		id := goAdListID(u.String())
		if slices.ContainsFunc(a.lists, func(l *goAdList) bool { return l.ID == id || l.URL == u.String() }) {
			a.mu.Unlock()
			return errors.New("That list is already here.")
		}
		if len(a.lists) >= maxGoAdLists {
			a.mu.Unlock()
			return fmt.Errorf("There can be at most %d filter lists.", maxGoAdLists)
		}
		name := u.Host + u.EscapedPath()
		a.mu.Unlock()
		// Had first: one that can't be isn't added.
		a.updates.Lock()
		defer a.updates.Unlock()
		l := &goAdList{ID: id, Name: name, URL: u.String(), On: true}
		data, header, err := a.fetch(ctx, *l, false)
		if err != nil {
			return err
		}
		r := newGoAdRules()
		_, expires := goParseAdList(r, data)
		if err := goAdNotList(r, data); err != nil {
			return err
		}
		if title := goAdListTitle(data); title != "" {
			l.Name = title
		}
		l.Rules, l.Unsupported, l.Expires = r.supported, r.unsupported, int64(expires/time.Second)
		l.ETag, l.LastModified = header.Get("ETag"), header.Get("Last-Modified")
		l.Updated, l.Tried = time.Now(), time.Now()
		a.mu.Lock()
		if a.dir != "" {
			if err := writeFileAtomic(a.path(l), data); err != nil {
				a.mu.Unlock()
				return fmt.Errorf("The list couldn't be kept: %v", err)
			}
		} else {
			l.text = data
		}
		if len(a.lists) >= maxGoAdLists || a.list(id) != nil {
			a.mu.Unlock()
			return errors.New("That list is already here.")
		}
		a.lists = append(a.lists, l)
		a.save()
		a.mu.Unlock()
		a.rebuild()
		return nil
	default:
		a.mu.Unlock()
		return errors.New("Unknown setting.")
	}
	a.save()
	a.mu.Unlock()
	a.rebuild()
	if setting == "on" || setting == "list-on" {
		// What's now wanted and not had: had now, so the page can say how
		// that went.
		return a.updateAll(ctx, goAdMissing)
	}
	return nil
}

// goAdNotList says why data, read into r, isn't a filter list: a web page
// (a sign-in, an error page), or nothing that's a rule.
func goAdNotList(r *goAdRules, data []byte) error {
	start := bytes.TrimLeft(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")), " \t\r\n")
	if bytes.HasPrefix(start, []byte("<")) {
		return errors.New("That's a web page, not a filter list: it has no rules.")
	}
	if r.supported == 0 && r.unsupported == 0 {
		return errors.New("That isn't a filter list: it has no rules.")
	}
	return nil
}

// goAdListTitle is what a list calls itself ("! Title: ..."), "" if it
// doesn't, among its first lines.
func goAdListTitle(data []byte) string {
	s := bufio.NewScanner(bytes.NewReader(data[:min(len(data), 8<<10)]))
	for i := 0; i < 40 && s.Scan(); i++ {
		if v, ok := strings.CutPrefix(strings.TrimSpace(strings.TrimPrefix(s.Text(), "!")), "Title:"); ok && strings.HasPrefix(s.Text(), "!") {
			v = strings.TrimSpace(v)
			if len(v) > 100 {
				v = v[:100]
			}
			return strings.ToValidUTF8(v, "")
		}
	}
	return ""
}

// routeGoAdBlock answers Settings: ad blocking's state and its lists.
func (g *server) routeGoAdBlock(c *tunnelCall) {
	if !g.goOn || g.goAds == nil {
		c.r.fail("The remote browser is off or unavailable.")
		return
	}
	c.r.finish(g.goAds.report())
}

// routeGoAdBlockSet makes a change (Setting; Name: a list's ID; URL: a
// list's address, to add).
func (g *server) routeGoAdBlockSet(c *tunnelCall) {
	if !g.goOn || g.goAds == nil {
		c.r.fail("The remote browser is off or unavailable.")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), goAdListTimeout*maxGoAdLists)
	defer cancel()
	err := g.goAds.set(ctx, c.req.Setting, c.req.Name, c.req.URL, c.req.Filters)
	log.Printf("go: ad blocking: %s from %s", c.req.Setting, c.ip)
	report := g.goAds.report()
	if err != nil {
		if c.req.Setting != "on" && c.req.Setting != "list-on" {
			c.r.fail(err.Error())
			return
		}
		report["error"] = err.Error()
	}
	// Turned on, or a list ticked: done, even if a list couldn't be had
	// (the report says which, and why).
	c.r.finish(report)
}

// routeGoAdBlockUpdate has the ticked lists anew (Name: one list's ID; ""
// for them all): Update now.
func (g *server) routeGoAdBlockUpdate(c *tunnelCall) {
	if !g.goOn || g.goAds == nil {
		c.r.fail("The remote browser is off or unavailable.")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), goAdListTimeout*maxGoAdLists)
	defer cancel()
	var err error
	if c.req.Name != "" {
		g.goAds.updates.Lock()
		err = g.goAds.update(ctx, c.req.Name)
		g.goAds.updates.Unlock()
	} else {
		err = g.goAds.updateAll(ctx, goAdAll)
	}
	report := g.goAds.report()
	if err != nil {
		report["error"] = err.Error()
	}
	c.r.finish(report)
}
