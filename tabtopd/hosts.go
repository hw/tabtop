package main

// Which names the tunnel answers to (WEB_HOSTS), against DNS rebinding.
//
// A website can't open the tunnel from its own pages: websocket.Accept
// refuses an Origin whose host isn't the request's Host (tunnelWS). But a
// website whose own name it makes resolve to this server's address (its
// DNS answering 127.0.0.1, or a LAN address, once its page has loaded) has
// pages whose origin's host is that name, and so is the tunnel request's
// Host: the check passes, and its page can try logins (with the well-known
// default TOTP secret, succeed: a terminal) against a server only its
// visitor's browser can reach. So a browser's tunnel is opened only by a
// name no website can point here:
//
//   - an address, as rebinding needs a name; or localhost, and names under
//     .localhost, which browsers keep to this machine;
//   - a name the public DNS doesn't have: a single label (a LAN's own,
//     "nas"), or under .local (mDNS), .home.arpa, .internal, or .lan (not
//     reserved, but common on home routers, and not in the public DNS);
//   - any name reached over HTTPS: to tabtopd itself, or a trusted proxy
//     that says so (secure), or an https: page's own (a browser opens only
//     wss: from one, which a name rebound here can't complete: it has no
//     certificate of this server's);
//   - a name listed in WEB_HOSTS (-hosts).
//
// A request without an Origin isn't a browser's (browsers send one with
// every WebSocket handshake), so it's no page's doing: it's let through, as
// any program reaching the port could send what it liked anyway.

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
)

// hostsPrivate are the suffixes of names the public DNS doesn't have.
var hostsPrivate = []string{".localhost", ".local", ".home.arpa", ".internal", ".lan"}

// hostName is r's Host as a name to compare: without its port or an IPv6
// address's brackets, in lower case, without a trailing dot.
func hostName(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.Trim(host, "[]"), ".")
	return strings.ToLower(host)
}

// hostUnrebindable reports whether name (hostName's) is one no website can
// make resolve to this server: an address, localhost, a single label, or
// under a suffix the public DNS doesn't have.
func hostUnrebindable(name string) bool {
	if name == "" {
		return false
	}
	if _, err := netip.ParseAddr(name); err == nil {
		return true
	}
	if i := strings.IndexByte(name, '%'); i > 0 { // an IPv6 address's zone
		if _, err := netip.ParseAddr(name[:i]); err == nil {
			return true
		}
	}
	if name == "localhost" || !strings.Contains(name, ".") {
		return true
	}
	for _, s := range hostsPrivate {
		if strings.HasSuffix(name, s) {
			return true
		}
	}
	return false
}

// parseHosts reads WEB_HOSTS: names separated by commas or spaces.
func parseHosts(v string) ([]string, error) {
	var out []string
	for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
		name := hostName(f)
		if name == "" || name != strings.ToLower(strings.TrimSuffix(f, ".")) || strings.ContainsAny(name, "/:@?#") {
			return nil, fmt.Errorf("WEB_HOSTS takes names only, without a scheme, port or path (got %q)", f)
		}
		out = append(out, name)
	}
	return out, nil
}

// tunnelHostAllowed reports whether r, a tunnel's WebSocket request, may be
// answered: see the top of this file.
func (g *server) tunnelHostAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || strings.HasPrefix(origin, "https://") || g.secure(r) {
		return true
	}
	name := hostName(r.Host)
	if hostUnrebindable(name) {
		return true
	}
	for _, h := range g.hosts {
		if h == name {
			return true
		}
	}
	return false
}

// hostRefusals notes the names a tunnel was refused by, to log each once.
type hostRefusals struct {
	mu   sync.Mutex
	seen map[string]bool
}

// note reports whether name's refusal is the first, to be logged.
func (h *hostRefusals) note(name string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.seen[name] || len(h.seen) >= 64 {
		return false
	}
	if h.seen == nil {
		h.seen = map[string]bool{}
	}
	h.seen[name] = true
	return true
}

// hostRefusedReason is the tunnel's close reason, for the page to show: a
// WebSocket's is 123 bytes at most.
func hostRefusedReason(name string) string {
	clean := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '-' {
			return r
		}
		return -1
	}, name)
	if len(clean) > 40 {
		clean = clean[:40] + "…"
	}
	return fmt.Sprintf("This server doesn't answer to %s over HTTP: use HTTPS, or add it to WEB_HOSTS.", clean)
}

// refuseHost logs the tunnel's refusal (once for each name).
func (g *server) refuseHost(r *http.Request) {
	name := hostName(r.Host)
	if g.hostsRefused.note(name) {
		log.Printf("tunnel refused for Host %q over plain HTTP (from a page of %q): a name a website could point here; "+
			"use HTTPS, or add the name to WEB_HOSTS if it's this server's", name, r.Header.Get("Origin"))
	}
}
