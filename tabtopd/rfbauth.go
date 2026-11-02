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
	if minor, err = rfbVersion(c); err != nil {
		return false, 0, nil, err
	}
	if _, err = c.Write(rfbVersionMsg(minor)); err != nil {
		return false, 0, nil, err
	}
	var choice byte
	if minor == 3 {
		if upgrade != nil {
			return false, minor, nil, errors.New("the VNC server speaks RFB 3.3, which has no VeNCrypt, as VNC_X509 requires")
		}
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
		case upgrade != nil:
			if !slices.Contains(types, byte(19)) {
				return false, minor, nil, errors.New("the VNC server doesn't offer VeNCrypt, as VNC_X509 requires")
			}
			choice = 19
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

// vncSecurity settles the security handshake between noVNC on page and
// the VNC server on vnc, with password, and returns the connection to
// relay the rest over: vnc, or a new one if the password was turned down.
func (g *server) vncSecurity(vnc net.Conn, page io.ReadWriter, password string) (net.Conn, error) {
	vnc.SetDeadline(time.Now().Add(rfbHandshakeTimeout))
	var upgrade func(io.ReadWriter) (io.ReadWriter, bool, error)
	if g.vncX509 {
		upgrade = func(c io.ReadWriter) (io.ReadWriter, bool, error) {
			plain := g.vncUsername != ""
			subtype := uint32(261)
			if plain {
				subtype = 262
			}
			if err := negotiateX509(c, subtype); err != nil {
				return nil, false, err
			}
			cfg, err := g.vncTLSConfig()
			if err != nil {
				return nil, false, err
			}
			secure := tls.Client(vnc, cfg)
			if err := secure.Handshake(); err != nil {
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
			return vnc, err
		}
		// noVNC asks for the server's own password instead, rather than
		// reconnecting with the same one again and again.
		log.Printf("%v; noVNC will ask for the VNC server's password", err)
		vnc.Close()
		return g.dialVNC()
	}
	if err != nil {
		return vnc, err
	}
	if done {
		return vnc, rfbOfferNone(page)
	}
	return vnc, rfbReplay(page, minor, replay)
}

func negotiateX509VNC(c io.ReadWriter) error {
	return negotiateX509(c, 261)
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
	if g.vncCAFile != "" {
		pem, err := os.ReadFile(g.vncCAFile)
		if err != nil {
			return nil, err
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("VNC_CA_FILE holds no PEM certificates")
		}
		cfg.RootCAs = roots
	}
	return cfg, nil
}
