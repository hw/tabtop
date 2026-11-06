package main

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strings"
)

// clientIP is the address failed logins are counted against. It's the
// connection's peer, unless that peer is a trusted proxy: then it's taken from
// X-Forwarded-For, walking right to left past entries added by trusted
// proxies. The first untrusted entry is the client; anything left of it was
// supplied by the client and could be forged, so it's ignored. Nobody else's
// X-Forwarded-For is read, so a client can't pick its own address to dodge
// the limit.
//
// A hop is a trusted proxy if its address is in -trusted-proxies, or if it's
// one of the -trust-nproxies hops nearest the container, counting the
// connection's peer as the first: for proxies whose addresses change, such as
// a platform's load balancer. With more than there really are, the walk
// reaches entries the client wrote, so the count must be exact. The entry
// a trusted Cloudflare address added is the client, whatever its address.
func (g *server) clientIP(r *http.Request) string {
	client, _ := g.traceClientIP(r)
	return client
}

// hop is one address clientIP looked at, for the doctor report.
type hop struct {
	Addr    string `json:"addr"`
	From    string `json:"from"` // "connection" or "X-Forwarded-For"
	Trusted bool   `json:"trusted"`
	By      string `json:"by,omitempty"` // why it's trusted: "WEB_TRUSTED_PROXIES" or "WEB_TRUST_NPROXIES"
	Note    string `json:"note,omitempty"`
}

// trustedBy says why the hop at position i (0 for the connection's peer,
// then X-Forwarded-For entries from the right) is a trusted proxy, or "" if
// it isn't one.
func (g *server) trustedBy(addr netip.Addr, i int) string {
	switch {
	case g.trusted(addr):
		return "WEB_TRUSTED_PROXIES"
	case i < g.trustNProxies:
		return "WEB_TRUST_NPROXIES"
	}
	return ""
}

// traceClientIP is clientIP, also returning the addresses it looked at:
// the connection's peer first, then X-Forwarded-For entries right to left.
func (g *server) traceClientIP(r *http.Request) (string, []hop) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host, []hop{{Addr: host, From: "connection"}}
	}
	peer = peer.Unmap()
	by := g.trustedBy(peer, 0)
	if by == "" {
		return host, []hop{{Addr: host, From: "connection"}}
	}
	trace := []hop{{Addr: peer.String(), From: "connection", Trusted: true, By: by}}
	var entries []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		entries = append(entries, strings.Split(v, ",")...)
	}
	client := peer
	// Cloudflare is always the outermost proxy, so the entry it added is
	// the visitor even if it's one of Cloudflare's own addresses (a
	// Worker's request), whose entries further left are the visitor's own.
	afterCloudflare := inCloudflare(peer)
	for i, entry := range slices.Backward(entries) {
		entry = strings.TrimSpace(entry)
		addr, err := parseHop(entry)
		if err != nil {
			// Garbage from the client's side; stay with the last hop we trust.
			trace = append(trace, hop{Addr: entry, From: "X-Forwarded-For", Note: "not an IP address; stopped here"})
			break
		}
		client = addr
		if afterCloudflare {
			trace = append(trace, hop{Addr: addr.String(), From: "X-Forwarded-For",
				Note: "added by Cloudflare, so the visitor whatever its address"})
			break
		}
		// slices.Backward counts i down from the rightmost entry, which is
		// hop 1.
		by := g.trustedBy(addr, len(entries)-i)
		trace = append(trace, hop{Addr: addr.String(), From: "X-Forwarded-For", Trusted: by != "", By: by})
		if by == "" {
			break
		}
		afterCloudflare = inCloudflare(addr)
	}
	return client.String(), trace
}

// ipWarning says what's wrong, if r's client IP looks like a proxy's rather
// than the visitor's, else "": when a proxy says who it's passing on (in
// X-Forwarded-For, or Cloudflare's Cf-Ray), but isn't trusted, so the
// client is taken as the proxy itself; or when the client is taken as one
// of Cloudflare's addresses. Then failed logins from everyone count against
// one address, and Sessions and Activity shows the proxy's for every
// login. The rest is what /doctor would advise. A visitor connecting
// directly, with no such headers, is never warned about, whatever its
// address.
func (g *server) ipWarning(r *http.Request) string {
	client, trace := g.traceClientIP(r)
	a, err := netip.ParseAddr(client)
	if err != nil {
		return ""
	}
	cloudflare := inCloudflare(a.Unmap())
	proxied := r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Cf-Ray") != ""
	if !cloudflare && !(proxied && !trace[0].Trusted) {
		return ""
	}
	what := "a proxy's"
	if cloudflare {
		what = "one of Cloudflare's"
	}
	msg := fmt.Sprintf("The server sees this browser as %s, which looks like %s address rather than yours: "+
		"failed logins from everyone count against it, and the addresses on this page are the proxy's.", client, what)
	if d, _ := g.proxyReport(r)["diagnosis"].([]string); len(d) > 0 {
		msg += " " + d[0]
	}
	return msg
}

// secure reports whether the browser reached the site over HTTPS: to
// tabtopd itself, or to a trusted proxy that says so in X-Forwarded-Proto
// (anyone else's is ignored, as with X-Forwarded-For), for the doctor
// report.
func (g *server) secure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || g.trustedBy(peer.Unmap(), 0) == "" {
		return false
	}
	// A chain of proxies may list one scheme per hop; the first is the
	// browser's.
	proto, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	return strings.EqualFold(strings.TrimSpace(proto), "https")
}

func (g *server) trusted(addr netip.Addr) bool {
	addr = addr.Unmap()
	return slices.ContainsFunc(g.trustedProxies, func(p netip.Prefix) bool { return p.Contains(addr) })
}

// parseHop parses an X-Forwarded-For entry, which some proxies write with a
// port ("192.0.2.1:4711", "[2001:db8::1]:4711").
func parseHop(s string) (netip.Addr, error) {
	if addr, err := netip.ParseAddr(s); err == nil {
		return addr.Unmap(), nil
	}
	ap, err := netip.ParseAddrPort(s)
	return ap.Addr().Unmap(), err
}

// cloudflareRanges are the addresses Cloudflare's edge connects from, as
// published at https://www.cloudflare.com/ips-v4 and /ips-v6 (2026-10-31).
// "cloudflare" in -trusted-proxies stands for all of them.
var cloudflareRanges = mustParsePrefixes(`
	173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22
	141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20
	197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13
	104.24.0.0/14 172.64.0.0/13 131.0.72.0/22
	2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32
	2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32`)

func mustParsePrefixes(s string) []netip.Prefix {
	var prefixes []netip.Prefix
	for _, f := range strings.Fields(s) {
		prefixes = append(prefixes, netip.MustParsePrefix(f))
	}
	return prefixes
}

func inCloudflare(addr netip.Addr) bool {
	addr = addr.Unmap()
	return slices.ContainsFunc(cloudflareRanges, func(p netip.Prefix) bool { return p.Contains(addr) })
}

// describePrefixes lists prefixes for people to read, with Cloudflare's
// ranges shown as "cloudflare".
func describePrefixes(prefixes []netip.Prefix) []string {
	out := []string{}
	if !slices.ContainsFunc(cloudflareRanges, func(p netip.Prefix) bool { return !slices.Contains(prefixes, p) }) {
		out = append(out, "cloudflare")
		prefixes = slices.DeleteFunc(slices.Clone(prefixes), func(p netip.Prefix) bool {
			return slices.Contains(cloudflareRanges, p)
		})
	}
	for _, p := range prefixes {
		out = append(out, p.String())
	}
	return out
}

// parsePrefixes parses a comma- or space-separated list of IPs, CIDR
// ranges and "cloudflare"; a bare IP is a range of one.
func parsePrefixes(s string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		if strings.EqualFold(f, "cloudflare") {
			prefixes = append(prefixes, cloudflareRanges...)
			continue
		}
		if strings.Contains(f, "/") {
			p, err := netip.ParsePrefix(f)
			if err != nil {
				return nil, err
			}
			prefixes = append(prefixes, p.Masked())
			continue
		}
		addr, err := netip.ParseAddr(f)
		if err != nil {
			return nil, err
		}
		addr = addr.Unmap()
		prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
	}
	return prefixes, nil
}

func escapePath(p string) string {
	return (&url.URL{Path: p}).EscapedPath()
}

// ipWarningOf is ipWarning for the request that opened t, if it has one.
func (g *server) ipWarningOf(t *tunnel) string {
	if t.req == nil {
		return ""
	}
	return g.ipWarning(t.req)
}
