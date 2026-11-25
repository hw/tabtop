package main

// Cross-device login. Approval is made through a fresh authenticated session
// and compares the *requester's locally computed* full transcript digest.
// The QR identifier is not a credential and can never redeem a session.
import (
	"context"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	helloRemote      = 4
	remoteLabel      = "tabtop remote approval v1"
	remoteWait       = 2 * time.Minute
	remoteSessionMax = time.Hour
)

var errRemoteMissing = errors.New("This login request is unavailable, expired, or its fingerprint doesn't match. Start again on the requesting device.")

type remotePending struct {
	commit, secret                      []byte
	id, proof, approvalURL, ip, browser string
	created, expires                    time.Time
	decision                            chan bool
	decided                             bool
	approver                            string
}
type remoteAuthStore struct {
	mu      sync.Mutex
	pending map[string]*remotePending
}

func remoteProof(ya, yb, nonce []byte, id, approvalURL string, expires int64) string {
	digest := sha256Sum([]byte(remoteLabel+" approval"), ya, yb, nonce, []byte(id+"\n"+approvalURL+"\n"+strconv.FormatInt(expires, 10)))
	return base64.RawURLEncoding.EncodeToString(digest)
}
func remoteKeys(ee, ya, yb, nonce []byte) []byte {
	keys, err := hkdf.Key(sha256.New, ee, sha256Sum([]byte(remoteLabel), ya, yb, nonce), remoteLabel+" keys", 64)
	if err != nil {
		panic(err)
	}
	return keys
}
func remoteApprovedKeys(ee, hello, yb, nonce, secret []byte) []byte {
	material := append(append([]byte{}, ee...), secret...)
	keys, err := hkdf.Key(sha256.New, material, sha256Sum([]byte(remoteLabel), hello, yb, nonce), remoteLabel+" approved keys", 64)
	if err != nil {
		panic(err)
	}
	return keys
}
func remoteCode(proof string) string {
	b, _ := base64.RawURLEncoding.DecodeString(proof)
	if len(b) != 32 {
		return ""
	}
	s := strings.ToUpper(hex.EncodeToString(b[:4]))
	return s[:4] + "-" + s[4:]
}
func validApprovalURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && (u.Scheme == "https" || u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "[::1]" || u.Hostname() == "::1"))
}
func (g *server) approvalURL(r *http.Request) (string, error) {
	if g.remoteApprovalURL != "" {
		return g.remoteApprovalURL, nil
	}
	// The browser's Origin gives the public scheme behind a TLS terminator.
	origin := r.Header.Get("Origin")
	if origin == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		origin = scheme + "://" + r.Host
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("Configure WEB_REMOTE_APPROVAL_URL with a trusted HTTPS approval address.")
	}
	raw := u.Scheme + "://" + u.Host + g.abs("/auth/approve")
	if !validApprovalURL(raw) {
		return "", errors.New("Remote approval requires HTTPS, or localhost. Configure WEB_REMOTE_APPROVAL_URL for a trusted HTTPS address.")
	}
	return raw, nil
}

func (g *server) remoteTunnel(c *websocket.Conn, r *http.Request, hello []byte, handshaken func()) {
	if len(hello) != 64 {
		c.Close(websocket.StatusPolicyViolation, "bad hello")
		return
	}
	ip := g.clientIP(r)
	if g.lockedOut(ip) {
		c.Close(closeLoginRefused, "Too many failed attempts. Try again later.")
		return
	}
	stopWaiting, ok := g.passkeyWaits.startUpTo(limitKey(ip), passkeyWaits, passkeyWaitsPerIP)
	if !ok {
		c.Close(websocket.StatusTryAgainLater, "Too many logins are waiting. Try again shortly.")
		return
	}
	defer stopWaiting()
	approvalURL, err := g.approvalURL(r)
	if err != nil {
		c.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return
	}
	ee, err := x25519(eph, hello[:32])
	if err != nil {
		c.Close(websocket.StatusPolicyViolation, "bad hello")
		return
	}
	yb := eph.PublicKey().Bytes()
	nonce := make([]byte, 32)
	rand.Read(nonce)
	ctx, cancel := context.WithTimeout(context.Background(), remoteWait)
	defer cancel()
	if c.Write(ctx, websocket.MessageBinary, append(append([]byte{tunnelVersion}, yb...), nonce...)) != nil {
		return
	}
	keys := remoteKeys(ee, hello, yb, nonce)
	tunnel, err := newTunnel(c, keys[:32], keys[32:])
	if err != nil {
		return
	}
	now := g.clock.Now()
	p := &remotePending{id: newToken(), approvalURL: approvalURL, ip: ip, browser: browserName(r.Header.Get("User-Agent")), created: now, expires: now.Add(remoteWait), decision: make(chan bool, 1)}
	p.commit = append([]byte{}, hello[32:]...)
	p.proof = remoteProof(hello, yb, nonce, p.id, p.approvalURL, p.expires.UnixMilli())
	g.remoteAuth.mu.Lock()
	if g.remoteAuth.pending == nil {
		g.remoteAuth.pending = map[string]*remotePending{}
	}
	g.remoteAuth.pending[p.id] = p
	g.remoteAuth.mu.Unlock()
	defer func() { g.remoteAuth.mu.Lock(); delete(g.remoteAuth.pending, p.id); g.remoteAuth.mu.Unlock() }()
	c.SetReadLimit(1024)
	handshaken()
	if !writeRemote(ctx, tunnel, map[string]any{"id": p.id, "approval_url": p.approvalURL, "expires": p.expires.UnixMilli()}) {
		return
	}
	// Reading during the wait detects disconnect/cancel immediately. Any data
	// before approval is a protocol error. There is exactly one pending read.
	type incoming struct {
		typ  websocket.MessageType
		data []byte
		err  error
	}
	read := make(chan incoming, 1)
	go func() { typ, data, err := c.Read(ctx); read <- incoming{typ, data, err} }()
	select {
	case <-ctx.Done():
		c.Close(websocket.StatusPolicyViolation, "The approval request expired. Start again.")
		return
	case <-read:
		return
	case approved := <-p.decision:
		if !approved {
			c.Close(closeLoginFailed, "Login was denied on the approving device.")
			return
		}
	}
	g.remoteAuth.mu.Lock()
	bindingSecret := append([]byte{}, p.secret...)
	g.remoteAuth.mu.Unlock()
	approvedKeys := remoteApprovedKeys(ee, hello, yb, nonce, bindingSecret)
	tunnel, err = newTunnel(c, approvedKeys[:32], approvedKeys[32:])
	if err != nil {
		return
	}
	if !writeRemote(ctx, tunnel, map[string]any{"approved": true}) {
		return
	}
	var ack incoming
	select {
	case ack = <-read:
	case <-ctx.Done():
		return
	}
	if ack.err != nil || ack.typ != websocket.MessageBinary {
		return
	}
	plaintext, err := tunnel.recv.Open(nil, tunnelNonce(0), ack.data, nil)
	if err != nil || len(plaintext) < 1 || plaintext[0] != msgText {
		return
	}
	tunnel.recvN = 1
	var finish struct {
		Proof string `json:"proof"`
	}
	if json.Unmarshal(plaintext[1:], &finish) != nil || subtle.ConstantTimeCompare([]byte(finish.Proof), []byte(p.proof)) != 1 {
		return
	}
	if !g.clock.Now().Before(p.expires) {
		return
	}
	// The approval session must still be live at issuance. No failed send can
	// leave behind a usable session that the requester never received.
	g.remoteAuth.mu.Lock()
	approver := p.approver
	g.remoteAuth.mu.Unlock()
	if _, ok := g.sessionSecret(approver); !ok {
		return
	}
	stopWaiting()
	id, secret, history := g.newSessionFor(ip, p.browser+", remotely approved", remoteSessionMax)
	g.mu.Lock()
	if s := g.sessions[id]; s != nil {
		s.remoteApproved = true
	}
	g.mu.Unlock()
	if !writeRemote(ctx, tunnel, map[string]any{"ok": true, "session": id, "secret": base64.StdEncoding.EncodeToString(secret), "ip": ip, "logins": history, "expires": g.sessionExpiry(id).UnixMilli()}) {
		g.endSession(id, "Remote login was disconnected.", nil)
		return
	}
	g.activity.add("login", ip, "logged in with approval from another device%s", withBrowser(p.browser))
	tunnel.Close(websocket.StatusNormalClosure, "")
}
func writeRemote(ctx context.Context, t *tunnel, value any) bool {
	b, _ := json.Marshal(value)
	return t.Write(ctx, websocket.MessageText, b) == nil
}

func (g *server) remoteRequest(c *tunnelCall, decision *bool) {
	g.remoteAuth.mu.Lock()
	p := g.remoteAuth.pending[c.req.RemoteID]
	if p == nil || p.decided || !g.clock.Now().Before(p.expires) || subtle.ConstantTimeCompare([]byte(p.proof), []byte(c.req.RemoteProof)) != 1 {
		g.remoteAuth.mu.Unlock()
		c.r.fail(errRemoteMissing.Error())
		return
	}
	if decision != nil {
		secret, err := base64.RawURLEncoding.DecodeString(c.req.RemoteSecret)
		digest := sha256.Sum256(secret)
		if err != nil || len(secret) != 32 || subtle.ConstantTimeCompare(digest[:], p.commit) != 1 {
			g.remoteAuth.mu.Unlock()
			c.r.fail("The QR binding secret doesn't match this request. Scan the original QR code again.")
			return
		}
		g.mu.Lock()
		s := g.sessions[c.session]
		fresh := s != nil && !s.remoteApproved && g.liveLocked(s, g.clock.Now()) && !s.created.Before(p.created) && g.clock.Now().Sub(s.created) <= remoteWait
		g.mu.Unlock()
		if !fresh {
			g.remoteAuth.mu.Unlock()
			c.r.fail("Log in again on this device before approving or denying this request.")
			return
		}
		p.decided = true
		p.approver = c.session
		p.secret = secret
		p.decision <- *decision
		g.remoteAuth.mu.Unlock()
		action := "denied"
		if *decision {
			action = "approved"
		}
		g.activity.add("remote-approval", c.ip, "%s a remote login request from %s", action, p.ip)
		c.r.finish(map[string]any{"decided": true})
		return
	}
	info := map[string]any{"ip": p.ip, "browser": p.browser, "code": remoteCode(p.proof), "expires": p.expires.UnixMilli(), "session_minutes": min(int(g.sessionMax/time.Minute), 60), "approval_url": p.approvalURL}
	g.remoteAuth.mu.Unlock()
	c.r.finish(info)
}
func (g *server) routeRemoteInfo(c *tunnelCall)    { g.remoteRequest(c, nil) }
func (g *server) routeRemoteApprove(c *tunnelCall) { yes := true; g.remoteRequest(c, &yes) }
func (g *server) routeRemoteDeny(c *tunnelCall)    { no := false; g.remoteRequest(c, &no) }

// approveCSP is the approval page's: its script and the tunnel, nothing
// else; no site may frame it.
const approveCSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

func (g *server) approvePage(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/auth/approve" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", 405)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	setPageHeaders(w.Header(), approveCSP)
	if r.Method == http.MethodHead {
		return
	}
	fmt.Fprintf(w, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve a TabTop login</title><body style="margin:0;min-height:100dvh;font:15px/1.5 system-ui,sans-serif;color:#e8f0fe;background:#12151c"><main id="approval"></main><script type="module" src="%s"></script></html>`, g.abs("/tabtop/remote-approve.js"))
}
