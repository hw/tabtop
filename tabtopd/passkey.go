package main

// Passkeys (WebAuthn): logging in with a key the browser or a device holds,
// instead of the password + authenticator code.
//
// A passkey is added from a session, with the password + code given again
// (so a session someone else got hold of can't add one of its own, which
// would outlast logging out everywhere). The browser makes the key pair
// and gives the page its public key (getPublicKey, as SPKI DER), its
// algorithm and the authenticator data; attestation isn't asked for, so
// nothing more is to be had from the attestation object, which isn't read.
// What's kept: the key, its ID, the origin it was made on and so its RP
// ID, a name, and its signature counter.
//
// Logging in with one is a third kind of tunnel (see tunnel.go):
//
//	browser: 3, 3, ephemeral X25519 key Ya (32)
//	server:  3, ephemeral X25519 key Yb (32), nonce (32)
//	browser: the assertion, encrypted          {"id", "authenticator_data", "client_data", "signature", "user_handle"}
//	server:  {"ok":true,"session":...} encrypted, as a login tunnel's
//
// Both derive keys from X25519(Ya, Yb): HKDF-SHA256, salt SHA-256(label ||
// Ya || Yb || nonce), info "tabtop passkey keys", 64 bytes, from the
// browser, then from the server; and the WebAuthn challenge is
// SHA-256(label || " challenge" || Ya || Yb || nonce). The assertion signs
// the challenge, so it's good for this handshake alone: one that someone
// in between made with each side has other keys, so another challenge.
// Unlike CPace, this doesn't prove the server to the page; a page changed
// on the way, which could do anything, is outside what the tunnel guards
// against anyway (see tunnel.go).

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	helloPasskey          = 3
	passkeyLabel          = "tabtop passkey v3"
	passkeyMax            = 20
	passkeyWait           = 2 * time.Minute // for the browser to ask for, and get, the assertion
	passkeyAssertionLimit = 16 << 10
	passkeyChallengeLife  = 5 * time.Minute

	coseES256 = -7
	coseEdDSA = -8
	coseRS256 = -257

	authFlagUP = 0x01 // user present
	authFlagUV = 0x04 // user verified
	authFlagAT = 0x40 // attested credential data follows
)

// passkey is a passkey added.
type passkey struct {
	ID        string    `json:"id"`         // its credential ID, base64url
	Name      string    `json:"name"`       // as given when it was added
	PublicKey []byte    `json:"public_key"` // SPKI DER
	Alg       int       `json:"alg"`        // COSE algorithm
	SignCount uint32    `json:"sign_count"`
	Origin    string    `json:"origin"` // the page's, when it was added
	RPID      string    `json:"rp_id"`  // that origin's host
	Created   time.Time `json:"created"`
	LastUsed  time.Time `json:"last_used,omitzero"`
}

// passkeyStore keeps the passkeys added, in file ("" for in memory).
type passkeyStore struct {
	mu     sync.Mutex
	file   string
	userID []byte // the account's WebAuthn user handle
	keys   []*passkey
	broken bool // the file couldn't be read: left as it is, nothing added
	// pending are the challenges given to sessions to add a passkey with:
	// by session ID, each good once, for a while.
	pending map[string]passkeyChallenge
}

type passkeyChallenge struct {
	challenge []byte
	expires   time.Time
}

func newPasskeyStore(file string) *passkeyStore {
	s := &passkeyStore{file: file, pending: map[string]passkeyChallenge{}}
	if file != "" {
		data, err := os.ReadFile(file)
		switch {
		case errors.Is(err, os.ErrNotExist):
		case err != nil:
			log.Printf("passkeys: reading %s: %v; none can be used or added till it can be", file, err)
			s.broken = true
		default:
			var saved struct {
				Version  int        `json:"version"`
				UserID   []byte     `json:"user_id"`
				Passkeys []*passkey `json:"passkeys"`
			}
			if err := json.Unmarshal(data, &saved); err != nil || saved.Version != 1 || len(saved.UserID) != 16 {
				log.Printf("passkeys: %s isn't as it should be; none can be used or added till it's fixed or removed", file)
				s.broken = true
			} else {
				s.userID, s.keys = saved.UserID, saved.Passkeys
			}
		}
	}
	if s.userID == nil {
		s.userID = make([]byte, 16)
		rand.Read(s.userID)
	}
	return s
}

func (s *passkeyStore) saveLocked() error {
	if s.file == "" {
		return nil
	}
	data, err := json.MarshalIndent(map[string]any{"version": 1, "user_id": s.userID, "passkeys": s.keys}, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.file, data)
}

// unreadable is errPasskeysBroken if the file couldn't be read, so the
// passkeys in it can't be listed or used.
func (s *passkeyStore) unreadable() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken {
		return errPasskeysBroken
	}
	return nil
}

// roomLocked is why a passkey can't be added now, if it can't: the file
// unreadable, or as many added as can be. s.mu is held.
func (s *passkeyStore) roomLocked() error {
	if s.broken {
		return errPasskeysBroken
	}
	if len(s.keys) >= passkeyMax {
		return fmt.Errorf("There are %d passkeys already, as many as can be added: remove one first.", passkeyMax)
	}
	return nil
}

// room is roomLocked, for asking before the password + code is (a code
// is used up by being checked: not for what couldn't be done anyway).
func (s *passkeyStore) room() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.roomLocked()
}

// has reports whether the passkey id is one added.
func (s *passkeyStore) has(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.ContainsFunc(s.keys, func(k *passkey) bool { return k.ID == id })
}

// count is how many passkeys are added.
func (s *passkeyStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.keys)
}

// list is the passkeys added, without their keys.
func (s *passkeyStore) list() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	for _, k := range s.keys {
		out = append(out, map[string]any{"id": k.ID, "name": k.Name, "created": k.Created, "last_used": k.LastUsed, "rp_id": k.RPID})
	}
	return out
}

// challengeFor gives the session a challenge to add a passkey with, and
// what the page needs to ask for one.
func (s *passkeyStore) challengeFor(session string, now time.Time) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.roomLocked(); err != nil {
		return nil, err
	}
	for id, p := range s.pending {
		if now.After(p.expires) {
			delete(s.pending, id)
		}
	}
	c := make([]byte, 32)
	rand.Read(c)
	s.pending[session] = passkeyChallenge{c, now.Add(passkeyChallengeLife)}
	exclude := []string{}
	for _, k := range s.keys {
		exclude = append(exclude, k.ID)
	}
	b64 := base64.RawURLEncoding.EncodeToString
	return map[string]any{"challenge": b64(c), "user_id": b64(s.userID), "exclude": exclude}, nil
}

// takeChallenge is the session's challenge, if it has one still good,
// which it then hasn't.
func (s *passkeyStore) takeChallenge(session string, now time.Time) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pending[session]
	delete(s.pending, session)
	if !ok || now.After(p.expires) {
		return nil
	}
	return p.challenge
}

var errPasskeysBroken = errors.New("The passkeys file can't be read, so passkeys can't be used or added: see the gateway's log (docker logs).")

// add keeps k, named name.
func (s *passkeyStore) add(k *passkey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.roomLocked(); err != nil {
		return err
	}
	if slices.ContainsFunc(s.keys, func(o *passkey) bool { return o.ID == k.ID }) {
		return errors.New("That passkey has been added already.")
	}
	s.keys = append(s.keys, k)
	if err := s.saveLocked(); err != nil {
		s.keys = s.keys[:len(s.keys)-1]
		return fmt.Errorf("The passkey couldn't be saved: %v", err)
	}
	return nil
}

// remove removes the passkey id, saying what it was called.
func (s *passkeyStore) remove(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.keys, func(k *passkey) bool { return k.ID == id })
	if i < 0 {
		return "", errors.New("That passkey is gone already.")
	}
	k := s.keys[i]
	s.keys = slices.Delete(s.keys, i, i+1)
	if err := s.saveLocked(); err != nil {
		s.keys = slices.Insert(s.keys, i, k)
		return "", fmt.Errorf("The passkey couldn't be removed: %v", err)
	}
	return k.Name, nil
}

// --- What the browser sends ---

// passkeyRegistration is what the page sends to add a passkey: from the
// credential navigator.credentials.create made, base64url.
type passkeyRegistration struct {
	ID                string `json:"id"`
	PublicKey         string `json:"public_key"` // getPublicKey()
	Alg               int    `json:"alg"`        // getPublicKeyAlgorithm()
	AuthenticatorData string `json:"authenticator_data"`
	ClientData        string `json:"client_data"` // clientDataJSON
}

// passkeyAssertion is what the page sends to log in: from the credential
// navigator.credentials.get gave, base64url.
type passkeyAssertion struct {
	ID                string `json:"id"`
	AuthenticatorData string `json:"authenticator_data"`
	ClientData        string `json:"client_data"`
	Signature         string `json:"signature"`
	UserHandle        string `json:"user_handle"`
}

var b64url = base64.RawURLEncoding

func unb64(s string) ([]byte, error) { return b64url.DecodeString(strings.TrimRight(s, "=")) }

// clientData is what of clientDataJSON is checked.
type clientData struct {
	Type        string `json:"type"`
	Challenge   string `json:"challenge"`
	Origin      string `json:"origin"`
	CrossOrigin bool   `json:"crossOrigin"`
}

// checkClientData checks raw, clientDataJSON, is of typ, for challenge, from
// a page not in another's frame; and returns it.
func checkClientData(raw []byte, typ string, challenge []byte) (clientData, error) {
	var cd clientData
	if err := json.Unmarshal(raw, &cd); err != nil {
		return cd, errors.New("its client data can't be read")
	}
	got, err := unb64(cd.Challenge)
	switch {
	case cd.Type != typ:
		return cd, fmt.Errorf("it's for %q, not %q", cd.Type, typ)
	case err != nil || subtle.ConstantTimeCompare(got, challenge) != 1:
		return cd, errors.New("it's for another challenge")
	case cd.CrossOrigin:
		return cd, errors.New("it was made in a frame of another site")
	}
	return cd, nil
}

// rpIDOf is the RP ID a page at origin has by default: its host. Only
// HTTPS, or HTTP on localhost, as browsers allow; not an IP address, which
// they don't.
func rpIDOf(origin string) (string, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.Path != "" && u.Path != "/" {
		return "", errors.New("its origin isn't one")
	}
	host := u.Hostname()
	local := host == "localhost" || strings.HasSuffix(host, ".localhost")
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", errors.New("passkeys need HTTPS")
	}
	if net.ParseIP(host) != nil {
		return "", errors.New("passkeys need a name for the site, not an IP address")
	}
	return host, nil
}

// authData is what of authenticator data is checked.
type authData struct {
	rpIDHash  []byte
	flags     byte
	signCount uint32
	rest      []byte // attested credential data and extensions, if any
}

func parseAuthData(b []byte) (authData, error) {
	if len(b) < 37 {
		return authData{}, errors.New("its authenticator data is too short")
	}
	return authData{b[:32], b[32], binary.BigEndian.Uint32(b[33:37]), b[37:]}, nil
}

// check checks a is for rpID, with the user present and verified.
func (a authData) check(rpID string) error {
	want := sha256.Sum256([]byte(rpID))
	switch {
	case subtle.ConstantTimeCompare(a.rpIDHash, want[:]) != 1:
		return errors.New("it's for another site")
	case a.flags&authFlagUP == 0:
		return errors.New("no one was there to use it")
	case a.flags&authFlagUV == 0:
		return errors.New("it didn't check who was using it (a PIN, a fingerprint, a face)")
	}
	return nil
}

// verifyRegistration checks reg, made for challenge, and returns the
// passkey it adds, named name.
func verifyRegistration(reg passkeyRegistration, challenge []byte, name string, now time.Time) (*passkey, error) {
	fail := func(err error) (*passkey, error) { return nil, fmt.Errorf("That passkey can't be added: %v.", err) }
	id, err1 := unb64(reg.ID)
	der, err2 := unb64(reg.PublicKey)
	ad, err3 := unb64(reg.AuthenticatorData)
	cdRaw, err4 := unb64(reg.ClientData)
	if err := errors.Join(err1, err2, err3, err4); err != nil || len(id) == 0 || len(id) > 1023 {
		return fail(errors.New("what the browser sent is malformed"))
	}
	if len(der) == 0 {
		return fail(errors.New("this browser doesn't give its public key (it's too old for passkeys here)"))
	}
	cd, err := checkClientData(cdRaw, "webauthn.create", challenge)
	if err != nil {
		return fail(err)
	}
	rpID, err := rpIDOf(cd.Origin)
	if err != nil {
		return fail(err)
	}
	a, err := parseAuthData(ad)
	if err != nil {
		return fail(err)
	}
	if err := a.check(rpID); err != nil {
		return fail(err)
	}
	// The credential it's for, as the authenticator says.
	if a.flags&authFlagAT == 0 || len(a.rest) < 18 {
		return fail(errors.New("its authenticator data has no credential"))
	}
	n := int(binary.BigEndian.Uint16(a.rest[16:18]))
	if len(a.rest) < 18+n || string(a.rest[18:18+n]) != string(id) {
		return fail(errors.New("its authenticator data is for another credential"))
	}
	pub, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return fail(errors.New("its public key can't be read"))
	}
	switch k := pub.(type) {
	case *ecdsa.PublicKey:
		if reg.Alg != coseES256 || k.Curve.Params().Name != "P-256" {
			return fail(errors.New("its key isn't of a kind that's used here"))
		}
	case ed25519.PublicKey:
		if reg.Alg != coseEdDSA {
			return fail(errors.New("its key isn't of a kind that's used here"))
		}
	case *rsa.PublicKey:
		if reg.Alg != coseRS256 || k.N.BitLen() < 2048 {
			return fail(errors.New("its key isn't of a kind that's used here"))
		}
	default:
		return fail(errors.New("its key isn't of a kind that's used here"))
	}
	return &passkey{ID: b64url.EncodeToString(id), Name: name, PublicKey: der, Alg: reg.Alg, SignCount: a.signCount,
		Origin: cd.Origin, RPID: rpID, Created: now}, nil
}

// verifyAssertion checks a, made for challenge, was made with k, and
// returns its signature counter.
func (k *passkey) verifyAssertion(a passkeyAssertion, challenge []byte, userID []byte) (uint32, error) {
	ad, err1 := unb64(a.AuthenticatorData)
	cdRaw, err2 := unb64(a.ClientData)
	sig, err3 := unb64(a.Signature)
	handle, err4 := unb64(a.UserHandle)
	if errors.Join(err1, err2, err3, err4) != nil {
		return 0, errors.New("what the browser sent is malformed")
	}
	if len(handle) > 0 && subtle.ConstantTimeCompare(handle, userID) != 1 {
		return 0, errors.New("it's for another account")
	}
	cd, err := checkClientData(cdRaw, "webauthn.get", challenge)
	if err != nil {
		return 0, err
	}
	if cd.Origin != k.Origin {
		return 0, errors.New("it was used on another site than it was added on")
	}
	auth, err := parseAuthData(ad)
	if err != nil {
		return 0, err
	}
	if err := auth.check(k.RPID); err != nil {
		return 0, err
	}
	cdHash := sha256.Sum256(cdRaw)
	signed := append(append([]byte{}, ad...), cdHash[:]...)
	pub, err := x509.ParsePKIXPublicKey(k.PublicKey)
	if err != nil {
		return 0, errors.New("its key can't be read")
	}
	digest := sha256.Sum256(signed)
	ok := false
	switch p := pub.(type) {
	case *ecdsa.PublicKey:
		ok = k.Alg == coseES256 && ecdsa.VerifyASN1(p, digest[:], sig)
	case ed25519.PublicKey:
		ok = k.Alg == coseEdDSA && ed25519.Verify(p, signed, sig)
	case *rsa.PublicKey:
		ok = k.Alg == coseRS256 && rsa.VerifyPKCS1v15(p, crypto.SHA256, digest[:], sig) == nil
	}
	if !ok {
		return 0, errors.New("its signature is wrong")
	}
	// A counter that goes back is a copied key's (synced passkeys don't
	// count, and say 0). One now 0, though, is
	// an authenticator that's stopped keeping one (reset, or synced
	// since), not a copy's: refusing it would lock its owner out.
	if auth.signCount != 0 && auth.signCount <= k.SignCount {
		return 0, errors.New("its counter went back, as a copied key's would")
	}
	return auth.signCount, nil
}

// passkeyKeys and passkeyChallenge derive a passkey tunnel's keys (from
// the browser, then from the server) and its WebAuthn challenge.
func passkeyKeys(ee, ya, yb, nonce []byte) []byte {
	keys, err := hkdf.Key(sha256.New, ee, sha256Sum([]byte(passkeyLabel), ya, yb, nonce), "tabtop passkey keys", 64)
	if err != nil {
		panic(err)
	}
	return keys
}

func passkeyTunnelChallenge(ya, yb, nonce []byte) []byte {
	return sha256Sum([]byte(passkeyLabel+" challenge"), ya, yb, nonce)
}

// verifyLogin checks a, made for challenge, against the passkeys added; it
// records the one used, and returns its name.
func (s *passkeyStore) verifyLogin(a passkeyAssertion, challenge []byte, now time.Time) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken {
		return "", errPasskeysBroken
	}
	i := slices.IndexFunc(s.keys, func(k *passkey) bool { return k.ID == a.ID })
	if i < 0 {
		return "", errors.New("it isn't a passkey added here")
	}
	k := s.keys[i]
	count, err := k.verifyAssertion(a, challenge, s.userID)
	if err != nil {
		return "", err
	}
	k.SignCount, k.LastUsed = max(k.SignCount, count), now
	if err := s.saveLocked(); err != nil {
		log.Printf("passkeys: saving: %v", err)
	}
	return k.Name, nil
}

// passkeyName is name as given for a passkey, if it's one: a line of at
// most 50 characters, "Passkey" if none.
func passkeyName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Passkey"
	}
	if !utf8.ValidString(name) || strings.ContainsAny(name, "\r\n\t") || utf8.RuneCountInString(name) > 50 {
		return "", false
	}
	return name, true
}
