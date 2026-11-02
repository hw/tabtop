package main

// Logging in to the VNC server for the page. With a password for it
// (VNC_UPSTREAM_PASSWORD, never the login's own), the gateway takes the RFB
// security handshake on itself: it accepts the server's None security type
// if offered, or answers its VNC Authentication challenge with the
// password, then tells noVNC that no security is needed, and relays the
// rest (ClientInit onwards) unchanged. So the VNC server asks for nothing
// more after the TabTop login. Otherwise noVNC handles the handshake
// itself, as without a password: when the server offers neither type
// (VeNCrypt, RA2, Apple's), what the gateway has read is replayed to it,
// and when the server turns the password down, the gateway connects again
// and stays out of the way. Either way noVNC asks for the server's own
// password.
//
// RFB 3.3, 3.7 and 3.8 (RFC 6143) differ only in the handshake: 3.3's
// server picks the security type, and only 3.8 sends a SecurityResult for
// None and a reason with a failed one.
// With -vnc-x509, VeNCrypt 0.2 X509Vnc (or X509Plain with a username) is required: the upstream
// connection is wrapped in certificate-verified TLS before authentication,
// and errors never fall back to the unencrypted browser handshake.

import (
	"crypto/des"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math/bits"
	"net"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	rfbSecNone    = 1
	rfbSecVNCAuth = 2
	// How long the server gets to finish its side of the handshake.
	rfbHandshakeTimeout = 10 * time.Second
)

var rfbVersionRE = regexp.MustCompile(`^RFB 003\.(\d{3})\n$`)

// errVNCPasswordRejected is rfbLogin's error when the server turns the
// password down.
var errVNCPasswordRejected = errors.New("the VNC server rejected the login password")

// rfbVersion reads a ProtocolVersion message, returning its minor version
// as the gateway speaks it: 3, 7 or 8 (3.4 to 3.6 count as 3.3, as the
// RFC says, and anything after 3.8, as Apple's 3.889, as 3.8).
func rfbVersion(r io.Reader) (int, error) {
	b := make([]byte, 12)
	if _, err := io.ReadFull(r, b); err != nil {
		return 0, err
	}
	m := rfbVersionRE.FindSubmatch(b)
	if m == nil {
		return 0, fmt.Errorf("not an RFB version: %q", b)
	}
	minor, _ := strconv.Atoi(string(m[1]))
	switch {
	case minor < 3:
		return 0, fmt.Errorf("unsupported RFB version 3.%d", minor)
	case minor < 7:
		return 3, nil
	case minor == 7:
		return 7, nil
	}
	return 8, nil
}

func rfbVersionMsg(minor int) []byte { return fmt.Appendf(nil, "RFB 003.%03d\n", minor) }

// rfbReason reads a failure reason: a length, then the text.
func rfbReason(r io.Reader) string {
	var n uint32
	if binary.Read(r, binary.BigEndian, &n) != nil || n > 1<<16 {
		return "no reason given"
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return "no reason given"
	}
	return string(b)
}

// rfbResult reads a SecurityResult, with its reason in 3.8.
func rfbResult(r io.Reader, minor int) error {
	var res uint32
	if err := binary.Read(r, binary.BigEndian, &res); err != nil {
		return err
	}
	if res == 0 {
		return nil
	}
	if minor >= 8 {
		return fmt.Errorf("%w: %s", errVNCPasswordRejected, rfbReason(r))
	}
	return errVNCPasswordRejected
}

// vncAuthResponse answers a VNC Authentication challenge: the challenge
// DES-encrypted with the password's first 8 bytes (zero-padded), each with
// its bits reversed, as VNC has always done.
func vncAuthResponse(password string, challenge []byte) []byte {
	key := make([]byte, 8)
	copy(key, password)
	for i, b := range key {
		key[i] = bits.Reverse8(b)
	}
	c, _ := des.NewCipher(key) // 8 bytes: can't fail
	out := make([]byte, 16)
	c.Encrypt(out[:8], challenge[:8])
	c.Encrypt(out[8:], challenge[8:16])
	return out
}

// rfbLogin runs the client's side of the security handshake with the
// server on c. It returns done once security is settled, or else the
// version it agreed and the security message it read, for noVNC to handle.
func rfbLogin(c io.ReadWriter, password string) (done bool, minor int, replay []byte, err error) {
	return rfbLoginTransport(c, password, nil)
}

func rfbLoginTransport(c io.ReadWriter, password string, upgrade func(io.ReadWriter) (io.ReadWriter, bool, error)) (done bool, minor int, replay []byte, err error) {
	var choice byte
	if upgrade != nil {
		minor, err = beginVeNCrypt(c)
		if err != nil {
			return false, minor, nil, err
		}
		choice = 19
	} else {
		if minor, err = rfbVersion(c); err != nil {
			return false, 0, nil, err
		}
		if _, err = c.Write(rfbVersionMsg(minor)); err != nil {
			return false, 0, nil, err
		}
		if minor == 3 {
			var typ uint32
			if err = binary.Read(c, binary.BigEndian, &typ); err != nil {
				return false, 0, nil, err
			}
			switch {
			case typ == 0:
				return false, 0, nil, fmt.Errorf("the VNC server refused the connection: %s", rfbReason(c))
			case typ == rfbSecNone:
				return true, minor, nil, nil
			case typ != rfbSecVNCAuth:
				return false, minor, binary.BigEndian.AppendUint32(nil, typ), nil
			}
			choice = rfbSecVNCAuth
		} else {
			var n [1]byte
			if _, err = io.ReadFull(c, n[:]); err != nil {
				return false, 0, nil, err
			}
			if n[0] == 0 {
				return false, 0, nil, fmt.Errorf("the VNC server refused the connection: %s", rfbReason(c))
			}
			types := make([]byte, n[0])
			if _, err = io.ReadFull(c, types); err != nil {
				return false, 0, nil, err
			}
			switch {
			case slices.Contains(types, rfbSecNone):
				choice = rfbSecNone
			case slices.Contains(types, rfbSecVNCAuth):
				choice = rfbSecVNCAuth
			default:
				return false, minor, append(n[:], types...), nil
			}
			if _, err = c.Write([]byte{choice}); err != nil {
				return false, 0, nil, err
			}
		}
	}
	if choice == 19 {
		var plain bool
		if c, plain, err = upgrade(c); err != nil {
			return false, minor, nil, err
		}
		if plain {
			return true, minor, nil, rfbResult(c, minor)
		}
		choice = rfbSecVNCAuth
	}
	if choice == rfbSecVNCAuth {
		challenge := make([]byte, 16)
		if _, err = io.ReadFull(c, challenge); err != nil {
			return false, 0, nil, err
		}
		if _, err = c.Write(vncAuthResponse(password, challenge)); err != nil {
			return false, 0, nil, err
		}
		return true, minor, nil, rfbResult(c, minor)
	}
	if minor >= 8 {
		return true, minor, nil, rfbResult(c, minor) // None's result
	}
	return true, minor, nil, nil
}

// rfbOfferNone runs the server's side of the security handshake with
// noVNC on c, offering RFB 3.8 and no security.
func rfbOfferNone(c io.ReadWriter) error {
	if _, err := c.Write(rfbVersionMsg(8)); err != nil {
		return err
	}
	minor, err := rfbVersion(c)
	if err != nil {
		return err
	}
	if minor == 3 {
		_, err = c.Write(binary.BigEndian.AppendUint32(nil, rfbSecNone))
		return err
	}
	if _, err = c.Write([]byte{1, rfbSecNone}); err != nil {
		return err
	}
	var choice [1]byte
	if _, err = io.ReadFull(c, choice[:]); err != nil {
		return err
	}
	if choice[0] != rfbSecNone {
		return fmt.Errorf("noVNC chose security type %d", choice[0])
	}
	if minor >= 8 {
		_, err = c.Write([]byte{0, 0, 0, 0})
	}
	return err
}

// rfbReplay hands noVNC the handshake rfbLogin read but couldn't finish:
// the version it agreed, which noVNC must agree to as well, then the
// server's security message.
func rfbReplay(c io.ReadWriter, minor int, replay []byte) error {
	if _, err := c.Write(rfbVersionMsg(minor)); err != nil {
		return err
	}
	got, err := rfbVersion(c)
	if err != nil {
		return err
	}
	if got != minor {
		return fmt.Errorf("noVNC answered RFB 3.%d to 3.%d", got, minor)
	}
	_, err = c.Write(replay)
	return err
}

// beginVeNCrypt performs the common RFB security selection, stopping before TLS.
func beginVeNCrypt(vnc io.ReadWriter) (int, error) {
	minor, err := rfbVersion(vnc)
	if err != nil {
		return 0, err
	}
	if _, err := vnc.Write(rfbVersionMsg(minor)); err != nil {
		return 0, err
	}
	if minor == 3 {
		// A server refusing the connection, as TigerVNC does an address it
		// has blacklisted, says so in RFB 3.3 whatever it speaks otherwise:
		// its reason says more than that 3.3 has no VeNCrypt.
		var typ uint32
		if err := binary.Read(vnc, binary.BigEndian, &typ); err != nil {
			return 0, err
		}
		if typ == 0 {
			return 0, fmt.Errorf("the VNC server refused the connection: %s", rfbReason(vnc))
		}
		return 0, errors.New("the VNC server speaks RFB 3.3, which has no VeNCrypt, as VNC_X509 requires")
	}
	var n [1]byte
	if _, err := io.ReadFull(vnc, n[:]); err != nil {
		return 0, err
	}
	if n[0] == 0 {
		return 0, fmt.Errorf("the VNC server refused the connection: %s", rfbReason(vnc))
	}
	types := make([]byte, n[0])
	if _, err := io.ReadFull(vnc, types); err != nil {
		return 0, err
	}
	if !slices.Contains(types, byte(19)) {
		return 0, errors.New("the VNC server doesn't offer VeNCrypt, as VNC_X509 requires")
	}
	if _, err := vnc.Write([]byte{19}); err != nil {
		return 0, err
	}
	return minor, nil
}

// upgradeX509 verifies TLS before either diagnostics or credentials proceed.
func (g *server) upgradeX509(vnc net.Conn) (*tls.Conn, error) {
	if err := negotiateX509(vnc, g.x509Subtype()); err != nil {
		return nil, err
	}
	cfg, err := g.vncTLSConfig()
	if err != nil {
		return nil, err
	}
	secure := tls.Client(vnc, cfg)
	if err := secure.Handshake(); err != nil {
		return nil, err
	}
	return secure, nil
}

// vncBackoff keeps the gateway from logging in to the VNC server again
// and again while it fails, as with a wrong password or certificate under
// VNC_X509: noVNC reconnects every 2 seconds, and each try would be another
// failed login there, which can get the gateway's address blacklisted, or,
// with X509Plain, a Unix account locked. After a failure, the gateway
// doesn't log in to the server for vncBackoffMin, doubling with each
// further failure up to vncBackoffMax; a login that works resets it. Meanwhile, under VNC_X509 the
// desktop is refused, as there's no other way in; without it, the gateway
// stays out of the handshake, and noVNC asks for the server's password.
//
// One login handshake runs at a time (turn), so tabs reconnecting together
// can't each try the password before the first failure is recorded: the
// others wait their turn, then see the cooldown it set.
type vncBackoff struct {
	turn  sync.Mutex
	mu    sync.Mutex
	until time.Time
	delay time.Duration
	// The last time the gateway logged in to the server, and how it went,
	// for the doctor report, which doesn't log in itself: a check that
	// stopped short would count as an abandoned login there, and could get
	// the gateway blacklisted.
	lastAt  time.Time
	lastErr error
}

// record notes how a login to the server went: err is nil if it worked.
func (b *vncBackoff) record(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.lastAt, b.lastErr = time.Now(), err
}

// last is when the gateway last logged in to the server, and how it went;
// the zero time if it hasn't yet.
func (b *vncBackoff) last() (time.Time, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lastAt, b.lastErr
}

// begin waits for the turn to log in, and reports whether the server is
// in its cooldown; release gives the turn back.
func (b *vncBackoff) begin() (cooling bool) {
	b.turn.Lock()
	return b.waiting() > 0
}

func (b *vncBackoff) release() { b.turn.Unlock() }

const (
	vncBackoffMin = 30 * time.Second
	vncBackoffMax = 10 * time.Minute
)

// waiting reports how long until the server may be tried again, if it's
// not yet.
func (b *vncBackoff) waiting() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	return time.Until(b.until)
}

// failed records a failed login and returns how long until the next.
func (b *vncBackoff) failed() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.delay = min(max(b.delay*2, vncBackoffMin), vncBackoffMax)
	b.until = time.Now().Add(b.delay)
	return b.delay
}

func (b *vncBackoff) succeeded() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.until, b.delay = time.Time{}, 0
}

// vncPassword is the password to give the VNC server, from
// -vnc-password-file, read afresh for each connection, or "" for noVNC to
// ask for it. A file rather than a flag or the environment, where every
// process could read it, or the terminal's programs inherit it.
func (g *server) vncPassword() string {
	if g.vncPasswordFile == "" {
		return ""
	}
	b, err := os.ReadFile(g.vncPasswordFile)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("reading the VNC server's password: %v", err)
		}
		return ""
	}
	return strings.TrimSuffix(string(b), "\n")
}

// vncAuthOutcome separates authentication from transport fallback so the
// caller, rather than the handshake, owns retry policy.
type vncAuthOutcome uint8

const (
	vncAuthenticated vncAuthOutcome = iota
	vncBrowserAuthRequired
	vncPasswordRejected
)

type vncAuthResult struct {
	conn    net.Conn
	outcome vncAuthOutcome
}

// vncSecurity returns the connection whose ownership transfers to the caller,
// including on errors. A fallback connection does not imply authentication.
func (g *server) vncSecurity(vnc net.Conn, page io.ReadWriter, password string) (vncAuthResult, error) {
	vnc.SetDeadline(time.Now().Add(rfbHandshakeTimeout))
	var upgrade func(io.ReadWriter) (io.ReadWriter, bool, error)
	if g.vncX509 {
		upgrade = func(c io.ReadWriter) (io.ReadWriter, bool, error) {
			plain := g.vncUsername != ""
			secure, err := g.upgradeX509(vnc)
			if err != nil {
				return nil, false, err
			}
			vnc = secure
			if plain {
				if err := writePlainCredentials(secure, g.vncUsername, password); err != nil {
					return nil, false, err
				}
			}
			return secure, plain, nil
		}
	}
	done, minor, replay, err := rfbLoginTransport(vnc, password, upgrade)
	vnc.SetDeadline(time.Time{})
	if errors.Is(err, errVNCPasswordRejected) {
		if g.vncX509 {
			return vncAuthResult{vnc, vncPasswordRejected}, err
		}
		// noVNC asks for the server's own password instead, rather than
		// reconnecting with the same one again and again.
		log.Print(err) // the bridge says what happens next
		vnc.Close()
		next, dialErr := g.dialVNC()
		return vncAuthResult{next, vncPasswordRejected}, dialErr
	}
	if err != nil {
		return vncAuthResult{vnc, vncBrowserAuthRequired}, err
	}
	if done {
		return vncAuthResult{vnc, vncAuthenticated}, pageError(rfbOfferNone(page))
	}
	return vncAuthResult{vnc, vncBrowserAuthRequired}, pageError(rfbReplay(page, minor, replay))
}

// errPageHandshake marks an error on noVNC's side of the handshake, as when
// the page closes part way: not a failed login to the server.
var errPageHandshake = errors.New("noVNC's side of the handshake")

func pageError(err error) error {
	if err != nil {
		return fmt.Errorf("%w: %v", errPageHandshake, err)
	}
	return nil
}

func negotiateX509VNC(c io.ReadWriter) error {
	return negotiateX509(c, 261)
}

// x509Subtype is the VeNCrypt subtype VNC_X509 asks for: X509Plain (262)
// with a username, else X509Vnc (261).
func (g *server) x509Subtype() uint32 {
	if g.vncUsername != "" {
		return 262
	}
	return 261
}

// x509Name names a VeNCrypt subtype the gateway asks for.
func x509Name(subtype uint32) string {
	if subtype == 262 {
		return "X509Plain"
	}
	return "X509Vnc"
}

// negotiateX509 picks VeNCrypt 0.2's subtype wanted: 261 (X509Vnc) or 262
// (X509Plain).
func negotiateX509(c io.ReadWriter, wanted uint32) error {
	var version [2]byte
	if _, err := io.ReadFull(c, version[:]); err != nil {
		return err
	}
	if version[0] != 0 || version[1] < 2 {
		return fmt.Errorf("the VNC server speaks VeNCrypt %d.%d; 0.2 is needed", version[0], version[1])
	}
	if _, err := c.Write([]byte{0, 2}); err != nil {
		return err
	}
	var status [1]byte
	if _, err := io.ReadFull(c, status[:]); err != nil {
		return err
	}
	if status[0] != 0 {
		return errors.New("the VNC server refused VeNCrypt 0.2")
	}
	var count [1]byte
	if _, err := io.ReadFull(c, count[:]); err != nil {
		return err
	}
	found := false
	for range int(count[0]) {
		var subtype uint32
		if err := binary.Read(c, binary.BigEndian, &subtype); err != nil {
			return err
		}
		found = found || subtype == wanted
	}
	if !found {
		return fmt.Errorf("the VNC server doesn't offer %s; set its SecurityTypes to it", x509Name(wanted))
	}
	if err := binary.Write(c, binary.BigEndian, wanted); err != nil {
		return err
	}
	if _, err := io.ReadFull(c, status[:]); err != nil {
		return err
	}
	if status[0] != 1 {
		return fmt.Errorf("the VNC server refused %s", x509Name(wanted))
	}
	return nil
}

func writePlainCredentials(c io.Writer, username, password string) error {
	if uint64(len(username)) > 1<<32-1 || uint64(len(password)) > 1<<32-1 {
		return errors.New("VNC_UPSTREAM_USERNAME or VNC_UPSTREAM_PASSWORD is too long")
	}
	msg := binary.BigEndian.AppendUint32(nil, uint32(len(username)))
	msg = binary.BigEndian.AppendUint32(msg, uint32(len(password)))
	msg = append(msg, username...)
	msg = append(msg, password...)
	_, err := c.Write(msg)
	return err
}

func (g *server) vncTLSConfig() (*tls.Config, error) {
	name := g.vncServerName
	if name == "" {
		name, _, _ = net.SplitHostPort(g.vncAddr)
	}
	if name == "" {
		return nil, errors.New("VNC_X509 needs the name in the VNC server's certificate: set VNC_SERVER_NAME")
	}
	cfg := &tls.Config{ServerName: name, MinVersion: tls.VersionTLS12}
	// With VNC_CA_FILE, only its certificates are trusted: added to the
	// system's, any public CA's certificate for the server's name would do
	// as well. Without it, the system's are.
	if g.vncCAFile != "" {
		pem, err := os.ReadFile(g.vncCAFile)
		if err != nil {
			return nil, err
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("VNC_CA_FILE holds no PEM certificates")
		}
		cfg.RootCAs = roots
	}
	return cfg, nil
}
