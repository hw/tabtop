package main

// DNS over HTTPS (DoH, RFC 8484) for the remote browser (/go). Off by
// default: names are looked up by the system's DNS, as before. On (Settings,
// go-settings.js: Cloudflare's, Quad9's, or a server of the person's own),
// the names the browser reaches are looked up by that server alone: the
// engine's tunnels (its proxy dials them: goproxy.go), what this server
// fetches for its pages (resources, media), its downloads and its filter
// lists. Other fetches (the Files page's, previews') keep the system's DNS.
//
// While it's on there's no falling back to the system's DNS: a name the
// DoH server doesn't know, or can't say (SERVFAIL, no answer in time),
// isn't reached; nor is a name of the local network's, unless it's in the
// local records or /etc/hosts (goetchosts.go), which come first.
// Its answers go by the address policy as any other (dropped where a fetch
// mayn't go), are kept a while (their TTL, from 30 s to 5 min; a name not
// found, 30 s), and the DoH server's own name never goes through it: a
// preset's addresses are known (pinned), a custom server's name is looked
// up once by the system's DNS, again only if it can't be reached there.
// The DoH server is never a private network's, nor this machine's.
// Nothing here logs the names looked up. Local records (gohosts.go), then
// /etc/hosts (goetchosts.go), come before either.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// goDoHPreset is a DoH server Settings offers: its address, and its own
// (pinned: not looked up).
type goDoHPreset struct {
	endpoint string
	addrs    []netip.Addr
}

var goDoHPresets = map[string]goDoHPreset{
	"cloudflare": {"https://cloudflare-dns.com/dns-query", []netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("1.0.0.1"),
		netip.MustParseAddr("2606:4700:4700::1111"), netip.MustParseAddr("2606:4700:4700::1001")}},
	"quad9": {"https://dns.quad9.net/dns-query", []netip.Addr{netip.MustParseAddr("9.9.9.9"), netip.MustParseAddr("149.112.112.112"),
		netip.MustParseAddr("2620:fe::fe"), netip.MustParseAddr("2620:fe::9")}},
}

const (
	goDoHTimeout  = 5 * time.Second // one question's
	goDoHKeepMin  = 30 * time.Second
	goDoHKeepMax  = 5 * time.Minute
	goDoHKeepNone = 30 * time.Second // a name not found
	goDoHKeptMax  = 4096             // names kept
	goDoHReplyMax = 64 << 10         // a reply's bytes
)

// errGoDNS is a name the DoH server didn't find, or couldn't say: what the
// proxy refuses with ("dns"), and fetches fail with.
var errGoDNS = errors.New("the site's name couldn't be found by the DNS over HTTPS server")

// errGoDNSName is a name that can't be asked (a label over 63 bytes, say):
// not found, but not the server's answer (Settings' status leaves it out).
var errGoDNSName = fmt.Errorf("%w: not a name that can be asked", errGoDNS)

// goDoHNow is the DoH in use; nil: the system's DNS.
var goDoHNow atomic.Pointer[goDoH]

// goDoHAllow is where a DoH server may be: a public address, never a
// private network's nor this machine's (tests change it).
var goDoHAllow = fetchPolicy(false)

// goDoH looks names up by a DoH server.
type goDoH struct {
	endpoint string
	client   *http.Client

	mu   sync.Mutex
	kept map[string]goDoHAnswer // by name

	// When it last answered, and last failed and why (Settings says; no
	// name kept): Unix ms.
	okAt, errAt atomic.Int64
	errMsg      atomic.Pointer[string]
}

// note keeps how a question to the server went: answered (a name not
// found is an answer), or failed, unless the asker gave up first.
func (d *goDoH) note(err error) {
	switch {
	case errors.Is(err, errGoDNSName), errors.Is(err, context.Canceled):
	case err == nil || errors.Is(err, errGoDNS):
		d.okAt.Store(time.Now().UnixMilli())
	default:
		msg := err.Error()
		d.errMsg.Store(&msg)
		d.errAt.Store(time.Now().UnixMilli())
	}
}

// status is when it last answered and failed (Settings), as a report's.
func (d *goDoH) status() map[string]any {
	s := map[string]any{"ok": d.okAt.Load()}
	if at := d.errAt.Load(); at > 0 {
		s["errorAt"], s["error"] = at, *d.errMsg.Load()
	}
	return s
}

type goDoHAnswer struct {
	addrs []netip.Addr
	err   error // errGoDNS: not found
	until time.Time
}

// goDoHEndpoint is raw, if it's a DoH server's address: https, a host, no
// name and password in it; /dns-query if it has no path.
func goDoHEndpoint(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return "", errors.New("A DoH server's address is an https address, such as https://dns.example/dns-query.")
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/dns-query"
	}
	return u.String(), nil
}

// newGoDoH is DoH by endpoint (checked by goDoHEndpoint), its server at
// pinned (a preset's) or else where the system's DNS says.
func newGoDoH(endpoint string, pinned []netip.Addr) *goDoH {
	dialer := fetchDialer(goDoHAllow) // (as it is now)
	// Its addresses raced as a site's are (IPv6 black-holed, IPv4 still
	// tried in time: the request's few seconds aren't all the first's).
	racer := &goDialer{plain: dialer, allow: goDoHAllow, dial: dialer.DialContext}
	var (
		mu    sync.Mutex
		found []netip.Addr // a custom server's addresses, looked up once
	)
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		try := func(addrs []netip.Addr) (net.Conn, error) {
			return racer.dialRace(ctx, network, port, addrs)
		}
		if len(pinned) > 0 {
			return try(pinned)
		}
		if a, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
			return try([]netip.Addr{a})
		}
		if local, ok := goHostsLookup(host); ok {
			return try(local) // (a local record's)
		}
		mu.Lock()
		addrs := found
		mu.Unlock()
		if len(addrs) > 0 {
			if c, err := try(addrs); err == nil {
				return c, nil
			}
		}
		// (Not looked up yet, or moved: the system's DNS asked.)
		if addrs, err = net.DefaultResolver.LookupNetIP(ctx, "ip", host); err != nil {
			return nil, err
		}
		mu.Lock()
		found = addrs
		mu.Unlock()
		return try(addrs)
	}
	return &goDoH{endpoint: endpoint, kept: map[string]goDoHAnswer{}, client: &http.Client{
		Timeout: goDoHTimeout,
		Transport: &http.Transport{
			DialContext:         dial,
			ForceAttemptHTTP2:   true,
			TLSHandshakeTimeout: goDoHTimeout,
			MaxIdleConns:        4,
			IdleConnTimeout:     90 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// lookup is name's addresses (IPv4 and IPv6), as the DoH server says, or
// kept from when it last said; errGoDNS if it doesn't know it.
func (d *goDoH) lookup(ctx context.Context, name string) ([]netip.Addr, error) {
	name = strings.ToLower(strings.TrimSuffix(name, "."))
	d.mu.Lock()
	a, ok := d.kept[name]
	d.mu.Unlock()
	if ok && time.Now().Before(a.until) {
		return a.addrs, a.err
	}
	type result struct {
		addrs []netip.Addr
		ttl   time.Duration
		err   error
	}
	results := make(chan result, 2)
	for _, t := range []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA} {
		go func() {
			addrs, ttl, err := d.ask(ctx, name, t)
			results <- result{addrs, ttl, err}
		}()
	}
	var addrs []netip.Addr
	ttl := goDoHKeepMax
	var failed, missing error
	for range 2 {
		r := <-results
		switch {
		case errors.Is(r.err, errGoDNS):
			missing = r.err
		case r.err != nil:
			failed = r.err
		default:
			addrs = append(addrs, r.addrs...)
			ttl = min(ttl, r.ttl)
		}
	}
	if len(addrs) == 0 {
		if failed != nil {
			return nil, fmt.Errorf("%w (%v)", errGoDNS, failed) // (not kept: it may answer next time)
		}
		if missing == nil {
			missing = errGoDNS // (no address of either kind)
		}
		d.keep(name, goDoHAnswer{err: missing, until: time.Now().Add(goDoHKeepNone)})
		return nil, missing
	}
	// (Kept only whole: one question failing, the other's addresses are
	// used, not kept as all the name has.)
	if failed == nil {
		d.keep(name, goDoHAnswer{addrs: addrs, until: time.Now().Add(min(max(ttl, goDoHKeepMin), goDoHKeepMax))})
	}
	return addrs, nil
}

func (d *goDoH) keep(name string, a goDoHAnswer) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.kept) >= goDoHKeptMax {
		clear(d.kept)
	}
	d.kept[name] = a
}

// ask asks the DoH server one question: the addresses of type t name has,
// and for how long they hold; errGoDNS if there's no such name.
func (d *goDoH) ask(ctx context.Context, name string, t dnsmessage.Type) ([]netip.Addr, time.Duration, error) {
	addrs, ttl, err := d.askServer(ctx, name, t)
	d.note(err)
	return addrs, ttl, err
}

func (d *goDoH) askServer(ctx context.Context, name string, t dnsmessage.Type) ([]netip.Addr, time.Duration, error) {
	qname, err := dnsmessage.NewName(name + ".")
	if err != nil {
		return nil, 0, errGoDNSName
	}
	// (ID 0, as RFC 8484 asks, for caches on the way.)
	q := dnsmessage.Message{Header: dnsmessage.Header{RecursionDesired: true}, Questions: []dnsmessage.Question{{Name: qname, Type: t, Class: dnsmessage.ClassINET}}}
	msg, err := q.Pack()
	if err != nil {
		return nil, 0, errGoDNSName // (a label over 63 bytes, say: never sent)
	}
	ctx, cancel := context.WithTimeout(ctx, goDoHTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.endpoint, bytes.NewReader(msg))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	res, err := d.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "application/dns-message") {
		return nil, 0, fmt.Errorf("the DoH server answered %s", res.Status)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, goDoHReplyMax+1))
	if err != nil {
		return nil, 0, err
	}
	if len(body) > goDoHReplyMax {
		return nil, 0, errors.New("the DoH server's answer is too long")
	}
	return goDoHAnswerOf(body, t)
}

// goDoHAnswerOf reads a DoH server's reply to a question of type t.
func goDoHAnswerOf(body []byte, t dnsmessage.Type) ([]netip.Addr, time.Duration, error) {
	var m dnsmessage.Message
	if err := m.Unpack(body); err != nil || !m.Response {
		return nil, 0, errors.New("the DoH server's answer isn't a DNS reply")
	}
	switch m.RCode {
	case dnsmessage.RCodeSuccess:
	case dnsmessage.RCodeNameError:
		return nil, 0, errGoDNS
	default:
		return nil, 0, fmt.Errorf("the DoH server couldn't say (%v)", m.RCode)
	}
	var addrs []netip.Addr
	ttl := goDoHKeepMax
	for _, r := range m.Answers {
		var a netip.Addr
		switch body := r.Body.(type) {
		case *dnsmessage.AResource:
			if t == dnsmessage.TypeA {
				a = netip.AddrFrom4(body.A)
			}
		case *dnsmessage.AAAAResource:
			if t == dnsmessage.TypeAAAA {
				a = netip.AddrFrom16(body.AAAA)
			}
		}
		if a.IsValid() {
			addrs = append(addrs, a)
			ttl = min(ttl, time.Duration(r.Header.TTL)*time.Second)
		}
	}
	return addrs, ttl, nil
}

// check asks it for a name every DNS knows: whether it answers.
func (d *goDoH) check(ctx context.Context) error {
	if _, _, err := d.ask(ctx, "example.com", dnsmessage.TypeA); err != nil && !errors.Is(err, errGoDNS) {
		return fmt.Errorf("The DoH server didn't answer: %v", err)
	}
	return nil
}

// goDialer is where the remote browser connects (its proxy's tunnels, its
// own fetches): only where allow says, checked on the socket it opens; a
// name at its local records' addresses (gohosts.go), or /etc/hosts's
// (goetchosts.go), if it has any; else looked up by DoH while it's on (its
// answers where allow says only), else by the system's DNS, as before.
type goDialer struct {
	plain *net.Dialer
	allow func(netip.Addr) bool
	dial  func(ctx context.Context, network, addr string) (net.Conn, error) // an address's (plain's; tests change it)
}

func newGoDialer(allow func(netip.Addr) bool) *goDialer {
	plain := fetchDialer(allow)
	return &goDialer{plain: plain, allow: allow, dial: plain.DialContext}
}

func (d *goDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if _, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		return d.plain.DialContext(ctx, network, addr) // (an address: nothing to look up)
	}
	// In order (goetchosts.go): the local records, /etc/hosts, then DoH
	// or the system's DNS.
	addrs, local := goHostsLookup(host)
	if !local {
		addrs, local = goEtcHostsLookup(host)
	}
	if !local {
		doh := goDoHNow.Load()
		if doh == nil {
			return d.plain.DialContext(ctx, network, addr) // (the system's DNS)
		}
		if addrs, err = doh.lookup(ctx, host); err != nil {
			return nil, err
		}
	}
	var allowed []netip.Addr
	for _, a := range addrs {
		if d.allow(a) && (network != "tcp4" || a.Unmap().Is4()) && (network != "tcp6" || a.Is6() && !a.Is4In6()) {
			allowed = append(allowed, a)
		}
	}
	if len(allowed) == 0 {
		return nil, errFetchAddress
	}
	return d.dialRace(ctx, network, port, allowed)
}

// goDialFallback is how long IPv6 has before IPv4's tried too (Go's own
// dialling's: RFC 8305, Happy Eyeballs).
const goDialFallback = 300 * time.Millisecond

// dialRace dials addrs as Go's own dialling does: IPv6 first, IPv4 too
// after goDialFallback (or at once, IPv6 failing), the first connection
// taken; each family's addresses in turn, each its share of the time left.
func (d *goDialer) dialRace(ctx context.Context, network, port string, addrs []netip.Addr) (net.Conn, error) {
	var v6, v4 []netip.Addr
	for _, a := range addrs {
		if a.Is6() && !a.Is4In6() {
			v6 = append(v6, a)
		} else {
			v4 = append(v4, a)
		}
	}
	if len(v6) == 0 || len(v4) == 0 {
		return d.dialSerial(ctx, network, port, addrs)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		c   net.Conn
		err error
	}
	results := make(chan result, 2)
	try := func(addrs []netip.Addr) {
		go func() {
			c, err := d.dialSerial(ctx, network, port, addrs)
			results <- result{c, err}
		}()
	}
	try(v6)
	pending, fellBack := 1, false
	fallback := time.NewTimer(goDialFallback)
	defer fallback.Stop()
	var first error
	for {
		select {
		case <-fallback.C:
			if !fellBack {
				fellBack = true
				try(v4)
				pending++
			}
		case r := <-results:
			pending--
			if r.err == nil {
				// The other's connection, if it comes, let go.
				go func(left int) {
					for range left {
						if o := <-results; o.c != nil {
							o.c.Close()
						}
					}
				}(pending)
				return r.c, nil
			}
			if first == nil {
				first = r.err
			}
			if !fellBack {
				fellBack = true
				try(v4)
				pending++
			} else if pending == 0 {
				return nil, first
			}
		}
	}
}

// dialSerial dials addrs in turn, each its share of the time left (at
// least 2 s), as Go's own dialling does.
func (d *goDialer) dialSerial(ctx context.Context, network, port string, addrs []netip.Addr) (net.Conn, error) {
	err := error(errFetchAddress)
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(d.timeout()) // (once: the whole dial's)
	}
	for i, a := range addrs {
		share := time.Until(deadline) / time.Duration(len(addrs)-i)
		if share < 2*time.Second {
			share = min(2*time.Second, time.Until(deadline))
		}
		actx, cancel := context.WithTimeout(ctx, share)
		var c net.Conn
		c, err = d.dial(actx, network, net.JoinHostPort(a.String(), port))
		cancel()
		if err == nil {
			return c, nil
		}
		if ctx.Err() != nil {
			return nil, err
		}
	}
	return nil, err
}

func (d *goDialer) timeout() time.Duration {
	if d.plain != nil && d.plain.Timeout > 0 {
		return d.plain.Timeout
	}
	return 20 * time.Second
}
