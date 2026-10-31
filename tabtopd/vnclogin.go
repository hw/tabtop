package main

// The desktop login for noVNC without the tunnel. Xvnc asks for no login:
// it listens on a socket only the desktop user can open. The gateway runs
// the RFB handshake with noVNC itself, offering only VeNCrypt Plain, and
// checks the username and TOTP code (or password and code) before it
// connects noVNC to Xvnc.

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"slices"
	"time"

	"github.com/coder/websocket"
)

const (
	rfbVersion = "RFB 003.008\n"
	// Security types and the VeNCrypt subtype noVNC is held to.
	rfbNone       = 1
	rfbVeNCrypt   = 19
	vencryptPlain = 256
	// Longest Plain username and password accepted.
	maxPlainUser     = 255
	maxPlainPassword = 1024
)

var errBadHandshake = errors.New("unexpected RFB handshake from client")

// websockify bridges a noVNC WebSocket to Xvnc once its login succeeds.
// Accept also rejects cross-origin requests, so another site can't open a
// session in a visitor's browser.
func (g *server) websockify(w http.ResponseWriter, r *http.Request) {
	if g.useE2E(r) {
		http.Error(w, "only the encrypted tunnel is served", http.StatusNotFound)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"binary"}})
	if err != nil {
		return // Accept has already sent the error response.
	}
	c.SetReadLimit(maxClientMessage)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ws := websocket.NetConn(ctx, c, websocket.MessageBinary)
	defer ws.Close()
	g.bridgeVNC(ws, g.clientIP(r), g.audio.token(r))
}

// bridgeVNC logs a noVNC client in, counting the attempt against ip's
// limit, then connects it to Xvnc. Once it's logged in, audioToken may
// fetch audio from ip.
func (g *server) bridgeVNC(ws net.Conn, ip, audioToken string) {
	if !g.beginLogin(ip) {
		log.Printf("VNC connection from %s refused: too many failed logins", ip)
		refuseRFB(ws, "Too many failed login attempts. Try again in a few minutes.")
		return
	}
	log.Printf("VNC connection from %s", ip)
	// An idle handshake can't hold one of ip's login attempts forever.
	ws.SetDeadline(time.Now().Add(vncLoginTimeout))
	user, password, err := readPlainLogin(ws)
	if err != nil {
		g.endLogin(ip, false)
		log.Printf("VNC login from %s abandoned: %v", ip, err)
		return
	}
	if !startLoginWork() {
		g.endLogin(ip, false)
		log.Printf("VNC login from %s refused: %s", ip, loginBusy)
		writeSecurityResult(ws, loginBusyMsg)
		return
	}
	ok := g.vncCredentialsOK(user, password)
	endLoginWork()
	g.endLogin(ip, !ok)
	if !ok {
		log.Printf("VNC login from %s failed", ip)
		writeSecurityResult(ws, "Those credentials are wrong, expired or already used.")
		return
	}
	log.Printf("VNC login from %s succeeded", ip)

	vnc, err := g.dialVNC()
	if err == nil {
		err = startVNC(vnc)
	}
	if err != nil {
		log.Printf("cannot reach VNC server: %v", err)
		writeSecurityResult(ws, "The desktop isn't running.")
		if vnc != nil {
			vnc.Close()
		}
		return
	}
	defer vnc.Close()
	if writeSecurityResult(ws, "") != nil {
		return
	}
	ws.SetDeadline(time.Time{})
	g.audio.link(audioToken, ip)
	defer g.audio.unlink(audioToken, ip)

	done := make(chan struct{}, 2)
	go func() { io.Copy(vnc, ws); done <- struct{}{} }()
	go func() { io.Copy(ws, vnc); done <- struct{}{} }()
	// Either side closing ends the session; closing both stops the other copy.
	<-done
	ws.Close()
	vnc.Close()
	<-done
	log.Printf("VNC connection from %s closed", ip)
}

// vncCredentialsOK checks a Plain login: the desktop user's name, and the
// code (or password and code) as for the web logins.
func (g *server) vncCredentialsOK(user, password string) bool {
	want, _, ok := g.usersFileEntry()
	return ok && user == want && g.credentialsOK(password)
}

// readPlainLogin runs the server's side of the handshake up to the login,
// offering noVNC exactly one choice at each step:
//
//	server: "RFB 003.008\n"        client: "RFB 003.008\n"
//	server: 1, 19 (VeNCrypt)       client: 19
//	server: 0, 2 (VeNCrypt 0.2)    client: 0, 2
//	server: 0 (accepted), 1, 256   client: 256 (Plain, a U32)
//	client: U32 user length, U32 password length, user, password
func readPlainLogin(c io.ReadWriter) (user, password string, err error) {
	steps := []struct{ send, want []byte }{
		{[]byte(rfbVersion), []byte(rfbVersion)},
		{[]byte{1, rfbVeNCrypt}, []byte{rfbVeNCrypt}},
		{[]byte{0, 2}, []byte{0, 2}},
		{binary.BigEndian.AppendUint32([]byte{0, 1}, vencryptPlain), binary.BigEndian.AppendUint32(nil, vencryptPlain)},
	}
	for _, s := range steps {
		if _, err := c.Write(s.send); err != nil {
			return "", "", err
		}
		got := make([]byte, len(s.want))
		if _, err := io.ReadFull(c, got); err != nil {
			return "", "", err
		}
		if !bytes.Equal(got, s.want) {
			return "", "", errBadHandshake
		}
	}
	var lens [8]byte
	if _, err := io.ReadFull(c, lens[:]); err != nil {
		return "", "", err
	}
	ulen, plen := binary.BigEndian.Uint32(lens[:4]), binary.BigEndian.Uint32(lens[4:])
	if ulen > maxPlainUser || plen > maxPlainPassword {
		return "", "", errBadHandshake
	}
	buf := make([]byte, ulen+plen)
	if _, err := io.ReadFull(c, buf); err != nil {
		return "", "", err
	}
	return string(buf[:ulen]), string(buf[ulen:]), nil
}

// writeSecurityResult ends the handshake: success when reason is "", or a
// failure noVNC shows with the reason.
func writeSecurityResult(c io.Writer, reason string) error {
	if reason == "" {
		_, err := c.Write([]byte{0, 0, 0, 0})
		return err
	}
	msg := binary.BigEndian.AppendUint32([]byte{0, 0, 0, 1}, uint32(len(reason)))
	_, err := c.Write(append(msg, reason...))
	return err
}

// startVNC runs the client's side of Xvnc's handshake, choosing no login,
// so what follows is noVNC's ClientInit and the session.
func startVNC(vnc net.Conn) error {
	vnc.SetDeadline(time.Now().Add(vncProbeTimeout))
	defer vnc.SetDeadline(time.Time{})
	version := make([]byte, len(rfbVersion))
	if _, err := io.ReadFull(vnc, version); err != nil {
		return fmt.Errorf("reading Xvnc's greeting: %w", err)
	}
	if string(version) != rfbVersion {
		return fmt.Errorf("unexpected greeting %q", version)
	}
	if _, err := vnc.Write([]byte(rfbVersion)); err != nil {
		return err
	}
	n := make([]byte, 1)
	if _, err := io.ReadFull(vnc, n); err != nil {
		return err
	}
	types := make([]byte, n[0])
	if _, err := io.ReadFull(vnc, types); err != nil {
		return err
	}
	if !slices.Contains(types, rfbNone) {
		return fmt.Errorf("Xvnc asks for a login (security types %v)", types)
	}
	if _, err := vnc.Write([]byte{rfbNone}); err != nil {
		return err
	}
	result := make([]byte, 4)
	if _, err := io.ReadFull(vnc, result); err != nil {
		return err
	}
	if binary.BigEndian.Uint32(result) != 0 {
		return errors.New("Xvnc refused the connection")
	}
	return nil
}
