package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/cryptobyte"
	casn1 "golang.org/x/crypto/cryptobyte/asn1"
	"golang.org/x/crypto/ocsp"
)

// revokeCA is a test authority: its certificate, its key.
type revokeCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func newRevokeCA(t *testing.T, name string) revokeCA {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return revokeCA{cert, key}
}

// leaf is a certificate for site.test, of serial, naming crl.
func (ca revokeCA) leaf(t *testing.T, serial int64, crl string) tls.Certificate {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "site.test"}, DNSNames: []string{"site.test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if crl != "" {
		tmpl.CRLDistributionPoints = []string{crl}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// crl is ca's CRL listing serials, in force from this to next, naming idp
// as its distribution point (none: names none), signed by signer.
func (ca revokeCA) crl(t *testing.T, signer *ecdsa.PrivateKey, this, next time.Time, idp string, serials ...int64) []byte {
	t.Helper()
	tmpl := &x509.RevocationList{Number: big.NewInt(1), ThisUpdate: this, NextUpdate: next}
	for _, s := range serials {
		tmpl.RevokedCertificateEntries = append(tmpl.RevokedCertificateEntries, x509.RevocationListEntry{SerialNumber: big.NewInt(s), RevocationTime: this})
	}
	if idp != "" {
		var b cryptobyte.Builder
		b.AddASN1(casn1.SEQUENCE, func(b *cryptobyte.Builder) {
			b.AddASN1(casn1.Tag(0).ContextSpecific().Constructed(), func(b *cryptobyte.Builder) {
				b.AddASN1(casn1.Tag(0).ContextSpecific().Constructed(), func(b *cryptobyte.Builder) {
					b.AddASN1(casn1.Tag(6).ContextSpecific(), func(b *cryptobyte.Builder) { b.AddBytes([]byte(idp)) })
				})
			})
		})
		tmpl.ExtraExtensions = append(tmpl.ExtraExtensions, pkix.Extension{Id: goOIDIssuingDistributionPoint, Critical: true, Value: b.BytesOrPanic()})
	}
	der, err := x509.CreateRevocationList(rand.Reader, tmpl, ca.cert, signer)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

// TestGoRevokedHost: a site's certificate looked up in the CRL it names,
// on a connection of the checker's own: listed, revoked (and kept so);
// anything that isn't an answer, allowed.
func TestGoRevokedHost(t *testing.T) {
	ca := newRevokeCA(t, "TabTop Test CA")
	other := newRevokeCA(t, "TabTop Test CA") // (the same name, another key)
	var crlDER atomic.Pointer[[]byte]
	var crlAsked atomic.Int32
	crlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		crlAsked.Add(1)
		w.Write(*crlDER.Load())
	}))
	defer crlSrv.Close()
	goTestPorts(t, portOf(t, crlSrv.URL))
	crlURL := crlSrv.URL + "/1.crl"
	var site atomic.Pointer[tls.Certificate]
	siteSrv := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	siteSrv.TLS = &tls.Config{GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return site.Load(), nil }}
	siteSrv.StartTLS()
	defer siteSrv.Close()
	siteAddr := siteSrv.Listener.Addr().String()
	roots := x509.NewCertPool()
	roots.AddCert(ca.cert)
	// The site's port 443 is the test server's; the rest as they are.
	plain := &net.Dialer{}
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr == "site.test:443" {
			addr = siteAddr
		}
		return plain.DialContext(ctx, network, addr)
	}
	now := time.Now()
	for _, c := range []struct {
		name    string
		crl     []byte
		crlAt   string
		revoked bool
	}{
		{"listed", ca.crl(t, ca.key, now.Add(-time.Hour), now.Add(time.Hour), "", 7, 8), crlURL, true},
		{"not listed", ca.crl(t, ca.key, now.Add(-time.Hour), now.Add(time.Hour), "", 8), crlURL, false},
		{"the CRL's distribution point, its own", ca.crl(t, ca.key, now.Add(-time.Hour), now.Add(time.Hour), crlURL, 7), crlURL, true},
		{"another distribution point's CRL", ca.crl(t, ca.key, now.Add(-time.Hour), now.Add(time.Hour), crlSrv.URL+"/2.crl", 7), crlURL, false},
		{"signed by another key", ca.crl(t, other.key, now.Add(-time.Hour), now.Add(time.Hour), "", 7), crlURL, false},
		{"out of date", ca.crl(t, ca.key, now.Add(-3*time.Hour), now.Add(-2*time.Hour), "", 7), crlURL, false},
		{"not a CRL", []byte("not a CRL"), crlURL, false},
		{"unreachable", ca.crl(t, ca.key, now.Add(-time.Hour), now.Add(time.Hour), "", 7), "http://127.0.0.1:1/1.crl", false},
		{"on a port the browser doesn't reach", ca.crl(t, ca.key, now.Add(-time.Hour), now.Add(time.Hour), "", 7), "http://crl.test:8081/1.crl", false},
		{"no CRL named", nil, "", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			if c.crl != nil {
				crlDER.Store(&c.crl)
			}
			cert := ca.leaf(t, 7, c.crlAt)
			site.Store(&cert)
			r := &goRevocation{now: time.Now, roots: roots}
			if got := r.revokedHost(context.Background(), "site.test", dial); got != c.revoked {
				t.Fatalf("revoked %v, want %v", got, c.revoked)
			}
		})
	}
	// Kept: asked again, the CRL isn't fetched again; nor is the host's
	// certificate read again while its answer's kept.
	crl := ca.crl(t, ca.key, now.Add(-time.Hour), now.Add(time.Hour), "", 7)
	crlDER.Store(&crl)
	cert := ca.leaf(t, 7, crlURL)
	site.Store(&cert)
	r := &goRevocation{now: time.Now, roots: roots}
	before := crlAsked.Load()
	for range 3 {
		if !r.revokedHost(context.Background(), "site.test", dial) {
			t.Fatal("not revoked")
		}
	}
	if n := crlAsked.Load() - before; n != 1 {
		t.Errorf("the CRL fetched %d times", n)
	}
	// A certificate not trusted isn't this check's (the engine warns).
	untrusted := &goRevocation{now: time.Now, roots: x509.NewCertPool()}
	if untrusted.revokedHost(context.Background(), "site.test", dial) {
		t.Error("an untrusted chain taken as revoked")
	}
}

// TestGoRevokedCRLPolicy: a CRL's fetched by the dialer given, so where the
// browser may not go (a private address, here) isn't asked.
func TestGoRevokedCRLPolicy(t *testing.T) {
	ca := newRevokeCA(t, "TabTop Test CA")
	var asked atomic.Int32
	crlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		w.Write(ca.crl(t, ca.key, time.Now().Add(-time.Hour), time.Now().Add(time.Hour), "", 7))
	}))
	defer crlSrv.Close()
	goTestPorts(t, portOf(t, crlSrv.URL))
	cert := ca.leaf(t, 7, crlSrv.URL+"/1.crl")
	leaf, _ := x509.ParseCertificate(cert.Certificate[0])
	policy := newGoDialer(func(a netip.Addr) bool { return !a.IsLoopback() }).DialContext
	r := &goRevocation{now: time.Now}
	cs := tls.ConnectionState{PeerCertificates: []*x509.Certificate{leaf, ca.cert}, VerifiedChains: [][]*x509.Certificate{{leaf, ca.cert}}}
	if revoked, sure := r.revokedState(context.Background(), cs, policy); revoked || sure {
		t.Fatalf("revoked %v, sure %v", revoked, sure)
	}
	if asked.Load() != 0 {
		t.Fatal("a CRL at an address the browser may not reach was fetched")
	}
}

// TestGoRevokedConnection: tabtopd's own fetches refuse a connection whose
// certificate is revoked, and take one that isn't.
func TestGoRevokedConnection(t *testing.T) {
	ca := newRevokeCA(t, "TabTop Test CA")
	crlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(ca.crl(t, ca.key, time.Now().Add(-time.Hour), time.Now().Add(time.Hour), "", 7))
	}))
	defer crlSrv.Close()
	goTestPorts(t, portOf(t, crlSrv.URL))
	roots := x509.NewCertPool()
	roots.AddCert(ca.cert)
	r := &goRevocation{now: time.Now, roots: roots}
	for _, c := range []struct {
		serial  int64
		revoked bool
	}{{7, true}, {9, false}} {
		cert := ca.leaf(t, c.serial, crlSrv.URL+"/1.crl")
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) }))
		srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
		srv.StartTLS()
		dial := (&net.Dialer{}).DialContext
		client := &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dial(ctx, "tcp", srv.Listener.Addr().String())
			},
			TLSClientConfig: &tls.Config{RootCAs: roots, VerifyConnection: r.verifyConnection(dial)},
		}}
		res, err := client.Get("https://site.test/")
		if res != nil {
			res.Body.Close()
		}
		if got := err != nil && errors.Is(err, errGoCertRevoked); got != c.revoked || !c.revoked && err != nil {
			t.Errorf("serial %d: %v", c.serial, err)
		}
		srv.Close()
	}
	if !strings.Contains(goRefusals["revoked"], "revoked") {
		t.Error("no refusal said for a revoked certificate")
	}
}

// TestGoRevokedCRLDown: a CRL server that doesn't answer is waited for
// once: what names it next (another certificate, or the same one again, as
// TabTop's own fetches' each connection does) has no answer at once, not
// after the same wait again.
func TestGoRevokedCRLDown(t *testing.T) {
	ca := newRevokeCA(t, "TabTop Test CA")
	hang := make(chan struct{})
	crlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-hang:
		case <-r.Context().Done():
		}
	}))
	defer crlSrv.Close()
	defer close(hang)
	goTestPorts(t, portOf(t, crlSrv.URL))
	r := &goRevocation{now: time.Now}
	check := func(serial int64) time.Duration {
		cert := ca.leaf(t, serial, crlSrv.URL+"/1.crl")
		leaf, _ := x509.ParseCertificate(cert.Certificate[0])
		cs := tls.ConnectionState{PeerCertificates: []*x509.Certificate{leaf, ca.cert}, VerifiedChains: [][]*x509.Certificate{{leaf, ca.cert}}}
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		start := time.Now()
		if revoked, sure := r.revokedState(ctx, cs, (&net.Dialer{}).DialContext); revoked || sure {
			t.Fatalf("revoked %v, sure %v", revoked, sure)
		}
		return time.Since(start)
	}
	if d := check(7); d < 250*time.Millisecond {
		t.Fatalf("the first check didn't wait for the CRL: %v", d)
	}
	for _, serial := range []int64{8, 7} {
		if d := check(serial); d > 100*time.Millisecond {
			t.Errorf("serial %d: waited %v again for a CRL server that didn't answer", serial, d)
		}
	}
}

// TestGoRevokedStapled: a stapled OCSP Revoked is an answer; a Good one
// doesn't outweigh the CRL (the server chooses what it staples), and is an
// answer only with no CRL named.
func TestGoRevokedStapled(t *testing.T) {
	ca := newRevokeCA(t, "TabTop Test CA")
	crlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(ca.crl(t, ca.key, time.Now().Add(-time.Hour), time.Now().Add(time.Hour), "", 7))
	}))
	defer crlSrv.Close()
	goTestPorts(t, portOf(t, crlSrv.URL))
	staple := func(leaf *x509.Certificate, status int) []byte {
		der, err := ocsp.CreateResponse(ca.cert, ca.cert, ocsp.Response{Status: status, SerialNumber: leaf.SerialNumber, ThisUpdate: time.Now().Add(-time.Hour), NextUpdate: time.Now().Add(time.Hour), RevokedAt: time.Now().Add(-time.Hour)}, ca.key)
		if err != nil {
			t.Fatal(err)
		}
		return der
	}
	state := func(serial int64, crl string, status int) (bool, bool) {
		cert := ca.leaf(t, serial, crl)
		leaf, _ := x509.ParseCertificate(cert.Certificate[0])
		cs := tls.ConnectionState{PeerCertificates: []*x509.Certificate{leaf, ca.cert}, VerifiedChains: [][]*x509.Certificate{{leaf, ca.cert}}, OCSPResponse: staple(leaf, status)}
		return (&goRevocation{now: time.Now}).revokedState(context.Background(), cs, (&net.Dialer{}).DialContext)
	}
	if revoked, sure := state(7, crlSrv.URL+"/1.crl", ocsp.Good); !revoked || !sure {
		t.Errorf("a stapled Good outweighed the CRL listing it: revoked %v, sure %v", revoked, sure)
	}
	if revoked, sure := state(9, "", ocsp.Revoked); !revoked || !sure {
		t.Errorf("a stapled Revoked not taken: revoked %v, sure %v", revoked, sure)
	}
	if revoked, sure := state(9, "", ocsp.Good); revoked || !sure {
		t.Errorf("a stapled Good with no CRL: revoked %v, sure %v", revoked, sure)
	}
}

// TestGoRevokedPartialCRL: a CRL that's only part of its issuer's (some
// reasons only, CA certificates only, indirect) isn't taken as saying a
// certificate it doesn't list isn't revoked; one for end entities only is.
func TestGoRevokedPartialCRL(t *testing.T) {
	ca := newRevokeCA(t, "TabTop Test CA")
	for _, c := range []struct {
		name    string
		field   func(b *cryptobyte.Builder)
		partial bool
	}{
		{"user certificates only", func(b *cryptobyte.Builder) {
			b.AddASN1(casn1.Tag(1).ContextSpecific(), func(b *cryptobyte.Builder) { b.AddUint8(0xff) })
		}, false},
		{"CA certificates only", func(b *cryptobyte.Builder) {
			b.AddASN1(casn1.Tag(2).ContextSpecific(), func(b *cryptobyte.Builder) { b.AddUint8(0xff) })
		}, true},
		{"some reasons only", func(b *cryptobyte.Builder) {
			b.AddASN1(casn1.Tag(3).ContextSpecific(), func(b *cryptobyte.Builder) { b.AddBytes([]byte{0x07, 0x80}) })
		}, true},
		{"indirect", func(b *cryptobyte.Builder) {
			b.AddASN1(casn1.Tag(4).ContextSpecific(), func(b *cryptobyte.Builder) { b.AddUint8(0xff) })
		}, true},
	} {
		var b cryptobyte.Builder
		b.AddASN1(casn1.SEQUENCE, c.field)
		tmpl := &x509.RevocationList{Number: big.NewInt(1), ThisUpdate: time.Now().Add(-time.Hour), NextUpdate: time.Now().Add(time.Hour),
			ExtraExtensions: []pkix.Extension{{Id: goOIDIssuingDistributionPoint, Critical: true, Value: b.BytesOrPanic()}}}
		der, err := x509.CreateRevocationList(rand.Reader, tmpl, ca.cert, ca.key)
		if err != nil {
			t.Fatal(err)
		}
		r := &goRevocation{now: time.Now}
		_, err = r.checkCRL(der, "http://crl.test/1.crl", ca.cert)
		if (err != nil) != c.partial {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}
