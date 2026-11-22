package main

// Certificate revocation for the remote browser (/go). Neither the engine
// (Moli checks no revocation, and says nothing over CDP of the certificate
// a connection of its got) nor Go's TLS checks whether a certificate's
// issuer has revoked it, so a site whose certificate was revoked was shown
// as secure (revoked.badssl.com). Chrome (CRLSets) and Firefox (CRLite)
// refuse such a site, with no way past.
//
// Now tabtopd looks the certificate up in the CRL it names (its CRL
// distribution point; or a stapled OCSP response, if the server sends one):
//   - before the engine's tunnel to an HTTPS host is spliced (goproxy.go),
//     for the certificate the host serves on a connection of tabtopd's own
//     (as goCertProbe reads it), its chain verified: revoked, the tunnel's
//     refused, as a blocked site's is ("revoked");
//   - on tabtopd's own fetches for the browser (pictures, stylesheets,
//     media, downloads: goClient), for the connection's own certificate.
//
// What the tunnel's check proves: whether the certificate the host serves
// tabtopd is revoked. Not the engine's connection's own (Moli doesn't say
// which it got): an attacker on the path could serve each differently. It
// still catches what it's for, a site serving a revoked certificate.
//
// Anything but an answer is no answer, and the site's allowed, as browsers
// soft-fail: no CRL named, one unreachable, too large, not signed by the
// certificate's issuer, out of date, or another one's (a sharded CRL's
// other part). No live OCSP: asking a CA's responder tells it each site
// visited. CRLs are fetched through the address policy (only where the
// browser may go, ports 80 and 443, http or https), kept till their next
// update (64 at most, 16 MB each); a host's answer, 10 minutes (a minute
// with no answer). One check a host at a time; a tunnel waits 8 s at most.

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/asn1"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"golang.org/x/crypto/cryptobyte"
	casn1 "golang.org/x/crypto/cryptobyte/asn1"
	"golang.org/x/crypto/ocsp"
)

const (
	goRevokeWait   = 8 * time.Second  // the most a tunnel waits for the answer
	goRevokeKeep   = 10 * time.Minute // a host's answer kept
	goRevokeUnsure = time.Minute      // no answer (soft-failed): asked again after
	goRevokeHosts  = 4096
	goCRLMax       = 16 << 20
	goCRLsKept     = 64
	goCRLSkew      = 5 * time.Minute // clocks' disagreement allowed
)

// goCRLSerials bounds the revoked serials kept, all CRLs together (a CRL of
// more isn't kept, only used for the answer it was fetched for). (A
// variable: tests lower it.)
var goCRLSerials = 1 << 20

// errGoCertRevoked is a connection refused for its certificate's revocation.
var errGoCertRevoked = errors.New("the site's certificate has been revoked by its issuer")

// goRevoked is the process's checker: its CRLs and hosts' answers kept for
// every tab's.
var goRevoked = &goRevocation{now: time.Now}

type goDialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

type goRevocation struct {
	now   func() time.Time
	roots *x509.CertPool // what chains are verified to (nil: the system's; tests set it)
	// crlWait is how long a CRL's fetch may take, on its own time, not its
	// asker's (0: goRevokeWait; tests set it).
	crlWait time.Duration
	mu      sync.Mutex
	hosts   map[string]goRevokeAnswer
	crls    map[string]*goCRL
	// crlDown: CRL addresses that didn't answer lately (till when), not
	// asked again meanwhile: a CA's CRL server down would stall every new
	// host's tunnel, and each new connection of TabTop's own, its wait each.
	crlDown map[string]time.Time
	calls   map[string]*goRevokeCall // checks going, by host or CRL address
}

type goRevokeAnswer struct {
	revoked bool
	until   time.Time
}

type goRevokeCall struct {
	done    chan struct{}
	revoked bool
	crl     *goCRL
	err     error
}

// goCRL is a CRL's revoked serials, for its issuer, till its next update.
type goCRL struct {
	issuer  []byte // the issuer's RawSubject
	serials map[string]struct{}
	next    time.Time
}

// revokedHost is whether host's certificate, as it serves it on a
// connection of dial's (port 443), is revoked: kept a while, one check a
// host at a time, waiting goRevokeWait at most (then: not, for now).
func (r *goRevocation) revokedHost(ctx context.Context, host string, dial goDialFunc) bool {
	key := "host " + goCertHost(host)
	r.mu.Lock()
	if a, ok := r.hosts[key]; ok && r.now().Before(a.until) {
		r.mu.Unlock()
		return a.revoked
	}
	call, going := r.calls[key]
	if !going {
		call = &goRevokeCall{done: make(chan struct{})}
		r.setCall(key, call)
	}
	r.mu.Unlock()
	if !going {
		go func() {
			// (Its own time, not the tunnel's: another asking meanwhile
			// gets its answer, and it's kept.)
			cctx, cancel := context.WithTimeout(context.Background(), goRevokeWait)
			defer cancel()
			revoked, sure := r.probe(cctx, host, dial)
			keep := goRevokeKeep
			if !sure {
				keep = goRevokeUnsure
			}
			r.mu.Lock()
			r.keepHost(key, goRevokeAnswer{revoked: revoked, until: r.now().Add(keep)})
			delete(r.calls, key)
			r.mu.Unlock()
			call.revoked = revoked
			close(call.done)
		}()
	}
	select {
	case <-call.done:
		return call.revoked
	case <-ctx.Done():
		return false
	}
}

// probe reads host's certificate on a connection of its own: revoked, and
// whether that's an answer (sure) or no answer (soft-failed).
func (r *goRevocation) probe(ctx context.Context, host string, dial goDialFunc) (revoked, sure bool) {
	raw, err := dial(ctx, "tcp", net.JoinHostPort(host, "443"))
	if err != nil {
		return false, false
	}
	defer raw.Close()
	conn := tls.Client(raw, &tls.Config{ServerName: host, InsecureSkipVerify: true, NextProtos: []string{"h2", "http/1.1"}})
	if conn.HandshakeContext(ctx) != nil {
		return false, false
	}
	defer conn.Close()
	cs := conn.ConnectionState()
	cs.ServerName = host // (an address's: no name sent)
	return r.revokedState(ctx, cs, dial)
}

// revokedState is whether cs's certificate is revoked (its chain verified,
// or verified here; one not trusted isn't this check's: the engine's
// warning is, gocert.go), and whether that's an answer.
func (r *goRevocation) revokedState(ctx context.Context, cs tls.ConnectionState, dial goDialFunc) (revoked, sure bool) {
	chains := cs.VerifiedChains
	if len(chains) == 0 {
		if len(cs.PeerCertificates) == 0 {
			return false, true
		}
		opts := x509.VerifyOptions{DNSName: cs.ServerName, Roots: r.roots, Intermediates: x509.NewCertPool()}
		for _, c := range cs.PeerCertificates[1:] {
			opts.Intermediates.AddCert(c)
		}
		var err error
		if chains, err = cs.PeerCertificates[0].Verify(opts); err != nil {
			return false, true
		}
	}
	if len(chains[0]) < 2 {
		return false, true // (a root itself: nothing above it to revoke it)
	}
	leaf, issuer := chains[0][0], chains[0][1]
	// A stapled OCSP response, if the server sent one (none asked of the
	// CA): signed for this certificate by its issuer, and current. Revoked
	// is an answer; Good only where there's no CRL to ask (the server
	// chooses what it staples: a stolen key's holder, the last Good from
	// before the revocation, good for days).
	stapledGood := false
	if len(cs.OCSPResponse) > 0 {
		if resp, err := ocsp.ParseResponseForCert(cs.OCSPResponse, leaf, issuer); err == nil && r.current(resp.ThisUpdate, resp.NextUpdate) {
			switch resp.Status {
			case ocsp.Revoked:
				return true, true
			case ocsp.Good:
				stapledGood = true
			}
		}
	}
	for _, at := range leaf.CRLDistributionPoints {
		crl, err := r.crl(ctx, at, issuer, dial)
		if err != nil {
			continue
		}
		_, revoked := crl.serials[string(leaf.SerialNumber.Bytes())]
		return revoked, true
	}
	return false, len(leaf.CRLDistributionPoints) == 0 || stapledGood
}

// current is whether a CRL's or response's times say it's in force now.
func (r *goRevocation) current(this, next time.Time) bool {
	now := r.now()
	return !this.After(now.Add(goCRLSkew)) && (next.IsZero() || now.Before(next.Add(goCRLSkew)))
}

// crl is the CRL at address, issued by issuer: kept till its next update,
// fetched (one fetch an address at a time) if it isn't.
func (r *goRevocation) crl(ctx context.Context, address string, issuer *x509.Certificate, dial goDialFunc) (*goCRL, error) {
	key := "crl " + address
	r.mu.Lock()
	if c, ok := r.crls[address]; ok && bytes.Equal(c.issuer, issuer.RawSubject) && r.now().Before(c.next) {
		r.mu.Unlock()
		return c, nil
	}
	if until, ok := r.crlDown[address]; ok && r.now().Before(until) {
		r.mu.Unlock()
		return nil, errors.New("the CRL's server didn't answer lately")
	}
	call, going := r.calls[key]
	if !going {
		call = &goRevokeCall{done: make(chan struct{})}
		r.setCall(key, call)
	}
	r.mu.Unlock()
	if !going {
		// On its own time, not the asker's: an asker that's spent its own
		// on a slow host's handshake gives up, and the CRL's still fetched,
		// kept for the next; only the CRL's server too slow, or failing,
		// has it taken as down.
		wait := r.crlWait
		if wait <= 0 {
			wait = goRevokeWait
		}
		go func() {
			fctx, cancel := context.WithTimeout(context.Background(), wait)
			defer cancel()
			call.crl, call.err = r.fetchCRL(fctx, address, issuer, dial)
			r.mu.Lock()
			if call.err == nil {
				r.keepCRL(address, call.crl)
				delete(r.crlDown, address)
			} else {
				if r.crlDown == nil {
					r.crlDown = map[string]time.Time{}
				}
				if len(r.crlDown) >= goCRLsKept {
					clear(r.crlDown)
				}
				r.crlDown[address] = r.now().Add(goRevokeUnsure)
			}
			delete(r.calls, key)
			r.mu.Unlock()
			close(call.done)
		}()
	}
	select {
	case <-call.done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if call.err == nil && !bytes.Equal(call.crl.issuer, issuer.RawSubject) {
		return nil, errors.New("another issuer's CRL")
	}
	return call.crl, call.err
}

// fetchCRL fetches the CRL at address and checks it's issuer's, current,
// and the one address names (its issuing distribution point, if it says).
func (r *goRevocation) fetchCRL(ctx context.Context, address string, issuer *x509.Certificate, dial goDialFunc) (*goCRL, error) {
	u, err := url.Parse(address)
	if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" || u.User != nil || !goPortAllowed(u) {
		return nil, errors.New("not a CRL address the browser may reach")
	}
	client := &http.Client{
		// (Its own: a CRL over https isn't itself checked for revocation.)
		Transport: &http.Transport{Proxy: nil, DialContext: dial, TLSHandshakeTimeout: goRevokeWait, ResponseHeaderTimeout: goRevokeWait, DisableKeepAlives: true},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 || req.URL.Scheme != "http" && req.URL.Scheme != "https" || req.URL.User != nil || !goPortAllowed(req.URL) {
				return errors.New("a CRL's redirect the browser may not follow")
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "TabTop")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the CRL's server answered %s", res.Status)
	}
	der, err := io.ReadAll(io.LimitReader(res.Body, goCRLMax+1))
	if err != nil {
		return nil, err
	}
	if len(der) > goCRLMax {
		return nil, errors.New("the CRL is too large")
	}
	if b, _ := pem.Decode(der); b != nil && b.Type == "X509 CRL" {
		der = b.Bytes
	}
	return r.checkCRL(der, address, issuer)
}

// checkCRL is der's revoked serials, if it's issuer's CRL (signed by it),
// in force now, and the one at address (by its issuing distribution point,
// if it names one: a sharded CRL's other part lists other certificates).
func (r *goRevocation) checkCRL(der []byte, address string, issuer *x509.Certificate) (*goCRL, error) {
	rl, err := x509.ParseRevocationList(der)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(rl.RawIssuer, issuer.RawSubject) {
		return nil, errors.New("the CRL is another issuer's")
	}
	if err := rl.CheckSignatureFrom(issuer); err != nil {
		return nil, err
	}
	if !r.current(rl.ThisUpdate, rl.NextUpdate) {
		return nil, errors.New("the CRL is out of date")
	}
	if names, partial, ok := goCRLScope(rl); !ok {
		return nil, errors.New("the CRL's distribution point can't be read")
	} else if partial {
		// Some reasons only, CA or attribute certificates only, or
		// another issuer's (indirect): a certificate not in it isn't
		// known not to be revoked.
		return nil, errors.New("the CRL is a part, not the whole")
	} else if len(names) > 0 {
		found := false
		for _, n := range names {
			found = found || n == address
		}
		if !found {
			return nil, errors.New("the CRL is another distribution point's")
		}
	}
	c := &goCRL{issuer: bytes.Clone(issuer.RawSubject), serials: make(map[string]struct{}, len(rl.RevokedCertificateEntries)), next: rl.NextUpdate}
	if c.next.IsZero() || c.next.After(r.now().Add(24*time.Hour)) {
		c.next = r.now().Add(24 * time.Hour) // (fetched again daily at least)
	}
	for _, e := range rl.RevokedCertificateEntries {
		if e.SerialNumber != nil {
			c.serials[string(e.SerialNumber.Bytes())] = struct{}{}
		}
	}
	return c, nil
}

var goOIDIssuingDistributionPoint = asn1.ObjectIdentifier{2, 5, 29, 28}

// goCRLScope is the URIs a CRL's issuing distribution point names (none:
// it names none, or has none); whether it's only part of what its issuer
// revoked, for a server's certificate (partial: some reasons only, CA or
// attribute certificates only, or indirect); and whether it could be read.
func goCRLScope(rl *x509.RevocationList) (names []string, partial, ok bool) {
	for _, e := range rl.Extensions {
		if !e.Id.Equal(goOIDIssuingDistributionPoint) {
			continue
		}
		// IssuingDistributionPoint ::= SEQUENCE {
		//   distributionPoint [0], onlyContainsUserCerts [1],
		//   onlyContainsCACerts [2], onlySomeReasons [3], indirectCRL [4],
		//   onlyContainsAttributeCerts [5] } (RFC 5280 5.2.5)
		var idp, dp cryptobyte.String
		var has bool
		s := cryptobyte.String(e.Value)
		if !s.ReadASN1(&idp, casn1.SEQUENCE) || !idp.ReadOptionalASN1(&dp, &has, casn1.Tag(0).ContextSpecific().Constructed()) {
			return nil, false, false
		}
		if has {
			var full cryptobyte.String
			var hasFull bool
			if !dp.ReadOptionalASN1(&full, &hasFull, casn1.Tag(0).ContextSpecific().Constructed()) {
				return nil, false, false
			}
			for hasFull && !full.Empty() {
				var name cryptobyte.String
				var tag casn1.Tag
				if !full.ReadAnyASN1(&name, &tag) {
					return nil, false, false
				}
				if tag == casn1.Tag(6).ContextSpecific() { // uniformResourceIdentifier
					names = append(names, string(name))
				}
			}
		}
		for !idp.Empty() {
			var field cryptobyte.String
			var tag casn1.Tag
			if !idp.ReadAnyASN1(&field, &tag) {
				return nil, false, false
			}
			switch tag {
			case casn1.Tag(2).ContextSpecific(), casn1.Tag(4).ContextSpecific(), casn1.Tag(5).ContextSpecific():
				// (BOOLEANs, DEFAULT FALSE: present, true; DER leaves out false.)
				partial = partial || len(field) == 1 && field[0] != 0
			case casn1.Tag(3).ContextSpecific(), casn1.Tag(3).ContextSpecific().Constructed():
				partial = true // onlySomeReasons
			}
		}
		return names, partial, true
	}
	return nil, false, true
}

// verifyConnection is a TLS config's VerifyConnection for tabtopd's own
// fetches: the connection's certificate refused if it's revoked.
func (r *goRevocation) verifyConnection(dial goDialFunc) func(tls.ConnectionState) error {
	return func(cs tls.ConnectionState) error {
		ctx, cancel := context.WithTimeout(context.Background(), goRevokeWait)
		defer cancel()
		if revoked, _ := r.revokedState(ctx, cs, dial); revoked {
			log.Printf("go: refused a connection to a site whose certificate is revoked")
			return errGoCertRevoked
		}
		return nil
	}
}

// (With r.mu held.)
func (r *goRevocation) setCall(key string, call *goRevokeCall) {
	if r.calls == nil {
		r.calls = map[string]*goRevokeCall{}
	}
	r.calls[key] = call
}

func (r *goRevocation) keepHost(key string, a goRevokeAnswer) {
	if r.hosts == nil {
		r.hosts = map[string]goRevokeAnswer{}
	}
	if len(r.hosts) >= goRevokeHosts {
		now := r.now()
		for k, v := range r.hosts {
			if !now.Before(v.until) || len(r.hosts) >= goRevokeHosts {
				delete(r.hosts, k)
			}
		}
	}
	r.hosts[key] = a
}

func (r *goRevocation) keepCRL(address string, c *goCRL) {
	if len(c.serials) > goCRLSerials {
		return // (more than all may come to: used, not kept)
	}
	if r.crls == nil {
		r.crls = map[string]*goCRL{}
	}
	delete(r.crls, address)
	total := len(c.serials)
	for _, v := range r.crls {
		total += len(v.serials)
	}
	if len(r.crls) >= goCRLsKept || total > goCRLSerials {
		// The out of date first, then any, till it fits.
		now := r.now()
		for k, v := range r.crls {
			if !now.Before(v.next) {
				total -= len(v.serials)
				delete(r.crls, k)
			}
		}
		for k, v := range r.crls {
			if len(r.crls) < goCRLsKept && total <= goCRLSerials {
				break
			}
			total -= len(v.serials)
			delete(r.crls, k)
		}
	}
	r.crls[address] = c
}
