package main

// Certificate errors in the remote browser (/go): a page whose HTTPS
// certificate isn't trusted (expired, self-signed, for another name) isn't
// shown, but a warning of TabTop's own (go-cert-warning): never the site's
// page. Its details come from a connection of tabtopd's own that reads the
// certificate and closes (goCertProbe); nothing's intercepted.
//
// Continue (go-cert-continue) adds the host to the tab's exceptions
// (goCertExceptions): for the tab's life, kept nowhere else. Then:
//   - the engine's told to ignore certificate errors while the tab's page is
//     on an excepted host, and only then (Moli: Security.
//     setIgnoreCertificateErrors, for the tab's session; it can't decide
//     request by request);
//   - meanwhile its proxy lets it reach no other host but by plain HTTP
//     (goProxy.tunnel, refuses): so what the engine ignores is the excepted
//     hosts' only (another host's HTTPS can't be checked without
//     intercepting it, which TabTop doesn't). A document the page goes to on
//     another host, so refused, is loaded again with the errors heeded
//     (gobrowser.go, certFailed);
//   - TabTop's own fetches for the tab (its pictures, stylesheets, media,
//     downloads) take the exceptions too (client): an excepted host's
//     certificate isn't checked, every other one is, on connections of the
//     tab's own (not shared with other tabs').

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// goCertExceptions are a tab's certificate exceptions, and what follows
// from them.
type goCertExceptions struct {
	mu    sync.Mutex
	hosts map[string]bool // continued to, this tab
	// revoked are those continued to past a revoked certificate's warning
	// alone (gorevoke.go): the engine has no error of its own to ignore
	// for them, so it isn't told to (nor are others' tunnels refused).
	revoked map[string]bool
	// revokedRefused: hosts the proxy refused this tab a tunnel to for
	// their certificate's revocation (gorevoke.go), till the tab's told
	// (tookRevoked): a load that failed so is warned of as that.
	revokedRefused map[string]time.Time          // (when: a note's for the load going, 30 s)
	refused        map[string]bool               // refused by the proxy, while ignoring
	clients        map[*http.Client]*http.Client // TabTop's own clients, with the exceptions

	// ignoring: the engine's told to ignore certificate errors (its page is
	// on an excepted host): the proxy refuses the others' (refuses).
	ignoring atomic.Bool
}

// goCertHostsMax bounds a tab's exceptions.
const goCertHostsMax = 64

func goCertHost(host string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
}

// allows is whether host's an exception.
func (c *goCertExceptions) allows(host string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hosts[goCertHost(host)]
}

// add makes host an exception (false if there are too many): for its
// certificate's revocation alone (revoked), or for the engine's error.
func (c *goCertExceptions) add(host string, revoked bool) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	host = goCertHost(host)
	if c.hosts == nil {
		c.hosts, c.revoked = map[string]bool{}, map[string]bool{}
	}
	if !c.hosts[host] && len(c.hosts) >= goCertHostsMax {
		return false
	}
	switch {
	case !c.hosts[host] && revoked:
		c.revoked[host] = true
	case !revoked:
		delete(c.revoked, host) // (the engine's error too, now)
	}
	c.hosts[host] = true
	return true
}

// refusedRevoked notes that the proxy refused host for its certificate's
// revocation.
func (c *goCertExceptions) refusedRevoked(host string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revokedRefused == nil {
		c.revokedRefused = map[string]time.Time{}
	}
	// (Notes for what isn't a page, a picture's, say, are never taken: let
	// go as they age, the oldest first when there are too many, so a page's
	// own is always noted.)
	now := time.Now()
	oldest, at := "", now
	for h, t := range c.revokedRefused {
		if now.Sub(t) > goRevokedNoteAge {
			delete(c.revokedRefused, h)
		} else if t.Before(at) {
			oldest, at = h, t
		}
	}
	if len(c.revokedRefused) >= 64 {
		delete(c.revokedRefused, oldest)
	}
	c.revokedRefused[goCertHost(host)] = now
}

// goRevokedNoteAge is how long a note of a host refused for its
// certificate's revocation is a load's to be warned of.
const goRevokedNoteAge = 30 * time.Second

// dropEngine takes host's exception away, if it's one past an engine's
// error (not a revocation's alone): continued to on an engine that can't
// ignore errors (gobrowser.go, certIgnore), it'd skip TabTop's own checks
// for the host and do nothing else.
func (c *goCertExceptions) dropEngine(host string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	host = goCertHost(host)
	if c.hosts[host] && !c.revoked[host] {
		delete(c.hosts, host)
	}
}

// tookRevoked is whether the proxy refused host for its certificate's
// revocation since it was last asked (the note let go).
func (c *goCertExceptions) tookRevoked(host string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	host = goCertHost(host)
	at, was := c.revokedRefused[host]
	delete(c.revokedRefused, host)
	return was && time.Since(at) <= goRevokedNoteAge
}

// ignores is whether the engine's to ignore certificate errors on host's
// pages: an exception for an error of the engine's (not a revocation's
// alone, which it doesn't see).
func (c *goCertExceptions) ignores(host string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	host = goCertHost(host)
	return c.hosts[host] && !c.revoked[host]
}

// any is whether there are exceptions.
func (c *goCertExceptions) any() bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.hosts) > 0
}

// client is base, for the tab's own fetches: with exceptions, a client of
// the tab's own whose connections skip the certificate check for an
// excepted host and make it in full for any other (redirects included).
func (c *goCertExceptions) client(base *http.Client) *http.Client {
	if base == nil || !c.any() {
		return base
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if made := c.clients[base]; made != nil {
		return made
	}
	for _, made := range c.clients {
		if made == base || made.Transport == base.Transport {
			return base // (one of the tab's own already, or a copy of one)
		}
	}
	t, ok := base.Transport.(*http.Transport)
	if !ok {
		return base // (not one to change: strict, as it is)
	}
	t = goDNSTransport(t.Clone()) // (its idle connections let go as names change, as its base's)
	base_ := t.TLSClientConfig
	dial := t.DialContext
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	handshake := t.TLSHandshakeTimeout
	if handshake <= 0 {
		handshake = 10 * time.Second
	}
	// TLS dialled here, so the check knows the host dialled: a name, or an
	// address (for which no name's sent, the connection's ServerName empty).
	t.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		raw, err := dial(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		cfg := base_.Clone()
		if cfg == nil {
			cfg = &tls.Config{}
		}
		roots := cfg.RootCAs
		revoked := cfg.VerifyConnection // (goClient's: a revoked certificate refused)
		cfg.ServerName = host
		cfg.NextProtos = []string{"h2", "http/1.1"}
		cfg.InsecureSkipVerify = true // (checked here, by host)
		cfg.VerifyConnection = func(cs tls.ConnectionState) error {
			if c.ignores(host) {
				return nil // (continued to past the engine's error)
			}
			cs.ServerName = host
			if err := goCertVerify(cs, roots); err != nil {
				return err
			}
			// Continued to past its revocation alone: checked in full
			// still, only its revocation not looked up.
			if revoked != nil && !c.allows(host) {
				return revoked(cs)
			}
			return nil
		}
		// (Bounded as the transport's own TLS is: it doesn't bound this.)
		hctx, cancel := context.WithTimeout(ctx, handshake)
		defer cancel()
		conn := tls.Client(raw, cfg)
		if err := conn.HandshakeContext(hctx); err != nil {
			raw.Close()
			return nil, err
		}
		return conn, nil
	}
	t.ForceAttemptHTTP2 = true
	made := *base
	made.Transport = t
	if c.clients == nil {
		c.clients = map[*http.Client]*http.Client{}
	}
	c.clients[base] = &made
	return &made
}

// goCertVerify checks a connection's certificate as Go's TLS does by
// default: its chain to a trusted root (roots, or the system's), and its
// name.
func goCertVerify(cs tls.ConnectionState, roots *x509.CertPool) error {
	if len(cs.PeerCertificates) == 0 {
		return errors.New("no certificate")
	}
	opts := x509.VerifyOptions{DNSName: cs.ServerName, Roots: roots, Intermediates: x509.NewCertPool()}
	for _, cert := range cs.PeerCertificates[1:] {
		opts.Intermediates.AddCert(cert)
	}
	_, err := cs.PeerCertificates[0].Verify(opts)
	return err
}

// wouldRefuse is whether a tunnel to host is one the proxy refuses TLS
// through, while the engine ignores certificate errors (refuses, without
// noting it).
func (c *goCertExceptions) wouldRefuse(host string) bool {
	return c != nil && c.ignoring.Load() && !c.ignores(host)
}

// refuses is whether the proxy's to refuse a tunnel to host: while the
// engine ignores certificate errors, any host's but one it ignores them for
// (an exception past the engine's own error; noted, for tookRefused).
func (c *goCertExceptions) refuses(host string) bool {
	// (An exception for a revocation alone isn't one the engine ignores
	// errors for: refused as any other host's meanwhile.)
	if c == nil || !c.ignoring.Load() || c.ignores(host) {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.refused == nil {
		c.refused = map[string]bool{}
	}
	for k := range c.refused {
		if len(c.refused) < 64 {
			break
		}
		delete(c.refused, k) // (one, not all: the page's own document's kept, likelier)
	}
	c.refused[goCertHost(host)] = true
	return true
}

// heeding is the engine told to heed certificate errors again: what the
// proxy refused meanwhile is forgotten.
func (c *goCertExceptions) heeding() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.refused = nil
	c.mu.Unlock()
}

// tookRefused is whether the proxy refused host for refuses (since asked
// last).
func (c *goCertExceptions) tookRefused(host string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	host = goCertHost(host)
	was := c.refused[host]
	delete(c.refused, host)
	return was
}

// goCertError is whether an engine's error text is a certificate's
// (Chrome's net::ERR_CERT_*, which Moli gives): not the site unreachable.
func goCertError(text string) bool {
	return strings.Contains(text, "ERR_CERT_") || strings.Contains(text, "ERR_INSECURE_RESPONSE")
}

// goCertReason is what an engine's certificate error says, in words.
func goCertReason(text string) string {
	switch {
	case strings.Contains(text, "ERR_CERT_DATE_INVALID"):
		return "Its certificate has expired, or isn't valid yet."
	case strings.Contains(text, "ERR_CERT_COMMON_NAME_INVALID"):
		return "Its certificate is for another site."
	case strings.Contains(text, "ERR_CERT_AUTHORITY_INVALID"):
		return "Its certificate isn't from an authority that's trusted (self-signed, or a private one)."
	case strings.Contains(text, "ERR_CERT_REVOKED"):
		return "Its certificate has been revoked by its issuer: it may have been stolen, or issued wrongly."
	case strings.Contains(text, "ERR_CERT_WEAK"), strings.Contains(text, "ERR_CERT_INVALID"):
		return "Its certificate isn't valid."
	}
	return "Its certificate isn't trusted."
}

// goCertDetails is what a certificate says, for the warning.
type goCertDetails struct {
	Subject  string   `json:"subject,omitempty"`
	Issuer   string   `json:"issuer,omitempty"`
	NotAfter string   `json:"notAfter,omitempty"`
	Names    []string `json:"names,omitempty"`
	Problem  string   `json:"problem,omitempty"` // what Go's check says is wrong with it
}

// goCertProbe reads host's certificate (port 443) on a connection of its
// own (dial: the address policy's), unchecked, and closes it: for the
// warning's words only. Nil if it can't be had.
func goCertProbe(ctx context.Context, dial func(ctx context.Context, network, addr string) (net.Conn, error), host string) *goCertDetails {
	if dial == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, err := dial(ctx, "tcp", net.JoinHostPort(host, "443"))
	if err != nil {
		return nil
	}
	conn := tls.Client(raw, &tls.Config{ServerName: host, InsecureSkipVerify: true})
	defer conn.Close()
	if conn.HandshakeContext(ctx) != nil {
		return nil
	}
	cs := conn.ConnectionState()
	if len(cs.PeerCertificates) == 0 {
		return nil
	}
	leaf := cs.PeerCertificates[0]
	d := &goCertDetails{Subject: leaf.Subject.CommonName, Issuer: leaf.Issuer.CommonName, NotAfter: leaf.NotAfter.UTC().Format("2006-01-02")}
	if d.Issuer == "" && len(leaf.Issuer.Organization) > 0 {
		d.Issuer = leaf.Issuer.Organization[0]
	}
	d.Names = append(d.Names, leaf.DNSNames[:min(len(leaf.DNSNames), 8)]...)
	for _, ip := range leaf.IPAddresses[:min(len(leaf.IPAddresses), 4)] {
		d.Names = append(d.Names, ip.String())
	}
	cs.ServerName = host // (an address's: no name sent, none said back)
	if err := goCertVerify(cs, nil); err != nil {
		var unknown x509.UnknownAuthorityError
		var invalid x509.CertificateInvalidError
		var name x509.HostnameError
		switch {
		case errors.As(err, &invalid) && invalid.Reason == x509.Expired:
			d.Problem = "expired, or not valid yet"
		case errors.As(err, &name):
			d.Problem = "for another name"
		case errors.As(err, &unknown):
			d.Problem = "not from a trusted authority"
		default:
			d.Problem = "not valid"
		}
	}
	return d
}
